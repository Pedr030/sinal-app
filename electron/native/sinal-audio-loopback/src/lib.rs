// Captura de áudio do Windows por processo (WASAPI "process loopback"),
// incluindo OU excluindo a árvore de um PID específico. Escrito do zero em
// cima da amostra oficial da Microsoft (Samples/ApplicationLoopback do repo
// microsoft/Windows-classic-samples) — ver HANDOFF.md pra por que isso é
// código próprio em vez de um pacote de terceiro pouco maduro.
//
// ATIVAÇÃO: via ActivateAudioInterfaceAsync() no dispositivo virtual
// (VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK), IGUAL à amostra oficial da
// Microsoft — não mais via IMMDevice::Activate() num dispositivo real, que
// foi usado por várias sessões como contorno de um E_INVALIDARG nunca
// explicado (ver HANDOFF §15.2). CAUSA RAIZ ACHADA (2026-09-22, sessão
// dedicada de pesquisa + teste em 2 máquinas físicas diferentes):
// `InitPropVariantFromBuffer` (usada aqui antes) NÃO cria um PROPVARIANT do
// tipo VT_BLOB — a documentação da própria função diz "Creates a VT_VECTOR |
// VT_UI1 propvariant" — enquanto a API exige VT_BLOB (ver remarks de
// IMMDevice::Activate). O E_INVALIDARG sempre foi o Windows corretamente
// rejeitando um PROPVARIANT malformado, não um bug da API ou do SO. Corrigido
// construindo o PROPVARIANT na mão (igual a amostra em C++ e o projeto real
// thomas-quant/wasapi-loopback, usado em produção pelo GoofCord pro mesmo
// caso de uso) — ver HANDOFF §15.11. Bônus: esse é o caminho que a Microsoft
// de fato valida/documenta pra esse recurso, e o único que os testes desta
// sessão confirmaram FILTRAR áudio por processo de verdade (o caminho
// síncrono ativava sem erro mas nunca filtrou nada, ver §15.7).
#![deny(unsafe_op_in_unsafe_fn)]

use std::mem::size_of;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::Arc;
use std::thread::JoinHandle;

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ErrorStrategy, ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;

use windows::core::{implement, imp::PROPVARIANT, Interface, Result as WinResult, GUID, HRESULT};
use windows::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0};
use windows::Win32::Media::Audio::{
    eConsole, eRender, ActivateAudioInterfaceAsync, IActivateAudioInterfaceAsyncOperation,
    IActivateAudioInterfaceCompletionHandler, IActivateAudioInterfaceCompletionHandler_Impl,
    IAudioCaptureClient, IAudioClient, IAudioSessionControl2, IAudioSessionManager2, IMMDeviceEnumerator,
    MMDeviceEnumerator, AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
    AUDCLNT_STREAMFLAGS_EVENTCALLBACK, AUDCLNT_STREAMFLAGS_LOOPBACK, AUDIOCLIENT_ACTIVATION_PARAMS,
    AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK, AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS, AudioSessionStateActive,
    PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE, PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE,
    VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, WAVEFORMATEX, WAVE_FORMAT_PCM,
};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoUninitialize, IAgileObject, CLSCTX_ALL, COINIT_MULTITHREADED};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::Threading::{CreateEventW, WaitForSingleObject};
use windows::Win32::System::Variant::VT_BLOB;
use windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;

// Completion handler da ativação assíncrona — igual ao padrão usado nos
// examples/diag_*.rs (já testado e validado nessa sessão). IAgileObject
// evita marshaling desnecessário entre apartamentos COM.
#[implement(IActivateAudioInterfaceCompletionHandler, IAgileObject)]
struct ActivationCompletionHandler {
    tx: std::sync::Mutex<Option<Sender<WinResult<IActivateAudioInterfaceAsyncOperation>>>>,
}
impl windows::Win32::System::Com::IAgileObject_Impl for ActivationCompletionHandler_Impl {}
impl IActivateAudioInterfaceCompletionHandler_Impl for ActivationCompletionHandler_Impl {
    fn ActivateCompleted(&self, op: Option<&IActivateAudioInterfaceAsyncOperation>) -> WinResult<()> {
        if let Some(tx) = self.tx.lock().unwrap().take() {
            let _ = tx.send(op.cloned().ok_or_else(|| windows::core::Error::from(HRESULT(-1))));
        }
        Ok(())
    }
}

const BITS_PER_BYTE: u32 = 8;
// Formato fixo — 16-bit PCM, 48kHz, estéreo. AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
// (abaixo) deixa o próprio Windows converter, então não precisamos negociar
// o formato nativo do dispositivo.
const SAMPLE_RATE: u32 = 48000;
const CHANNELS: u16 = 2;
const BITS_PER_SAMPLE: u16 = 16;

// A partir daqui: helpers pra descobrir QUAL PID usar, chamados do main.js
// antes de AudioLoopback::start(). O desktopCapturer do Electron só devolve
// um id tipo "window:67262:0" — o número é o HWND (handle de janela) em
// decimal, não o PID — por isso precisa desse passo.

/// HWND (o número que vem depois de "window:" no id do desktopCapturer, em
/// decimal) -> PID do processo dono da janela. `None` se a janela não
/// existir mais (fechou entre o usuário escolher e a gente processar).
#[napi]
pub fn get_window_process_id(hwnd: i64) -> Option<u32> {
    use windows::Win32::Foundation::HWND;
    let mut pid: u32 = 0;
    let hwnd = HWND(hwnd as *mut core::ffi::c_void);
    let thread_id = unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    if thread_id == 0 || pid == 0 {
        None
    } else {
        Some(pid)
    }
}

/// Acha o PID "raiz" do Discord (o processo que não é filho de outro
/// Discord.exe) — usado no modo "compartilhar tela inteira", onde a gente
/// sempre exclui o Discord em vez de incluir um app específico. Discord roda
/// vários processos (renderers, GPU, etc.) todos chamados Discord.exe; como
/// PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE exclui o alvo E os
/// filhos dele, achar a raiz garante que a árvore inteira fica de fora.
/// `None` se o Discord não estiver rodando.
#[napi]
pub fn find_discord_root_pid() -> Option<u32> {
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0).ok()?;

        let mut entry = PROCESSENTRY32W::default();
        entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;

        let mut discord_pids: Vec<(u32, u32)> = Vec::new(); // (pid, parent_pid)
        let mut ok = Process32FirstW(snapshot, &mut entry).is_ok();
        while ok {
            let name_len = entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(entry.szExeFile.len());
            let name = String::from_utf16_lossy(&entry.szExeFile[..name_len]);
            if name.eq_ignore_ascii_case("Discord.exe") {
                discord_pids.push((entry.th32ProcessID, entry.th32ParentProcessID));
            }
            ok = Process32NextW(snapshot, &mut entry).is_ok();
        }
        let _ = CloseHandle(snapshot);

        if discord_pids.is_empty() {
            return None;
        }
        let pids: std::collections::HashSet<u32> = discord_pids.iter().map(|(pid, _)| *pid).collect();
        // A raiz é a que o pai NÃO é outro Discord.exe (foi lançada pelo
        // explorer/atalho, não por outro processo do próprio Discord).
        discord_pids
            .iter()
            .find(|(_, parent)| !pids.contains(parent))
            .map(|(pid, _)| *pid)
            .or_else(|| discord_pids.first().map(|(pid, _)| *pid)) // fallback: qualquer um é melhor que nenhum
    }
}

/// DIAGNÓSTICO — não usado no fluxo normal do app, só pra investigar o
/// vazamento de áudio documentado em HANDOFF.md §15.4-15.6. Lista toda
/// sessão de áudio ATIVA no endpoint de renderização padrão agora mesmo,
/// junto com o PID dono e o nome do executável — ou seja, mostra
/// exatamente quem o Windows acha que está fazendo barulho neste segundo,
/// sem achismo. Rodar isso DURANTE uma call de voz real do Discord (ou
/// qualquer outro cenário de vazamento) é o próximo passo real da
/// investigação: se o PID de `find_discord_root_pid()` (ou da árvore dele)
/// não aparecer entre as sessões ativas listadas aqui enquanto a call toca,
/// a exclusão nunca tinha chance de funcionar — o alvo tava errado desde o
/// início, não é bug da API do Windows.
#[napi(object)]
pub struct AudioSessionInfo {
    pub pid: u32,
    pub exe_name: String,
    pub is_active: bool,
}

#[napi]
pub fn list_audio_sessions() -> Result<Vec<AudioSessionInfo>> {
    unsafe {
        CoInitializeEx(None, COINIT_MULTITHREADED).ok().map_err(|e| Error::from_reason(format!("CoInitializeEx: {e}")))?;

        let result = (|| -> WinResult<Vec<AudioSessionInfo>> {
            let enumerator: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
            let device = enumerator.GetDefaultAudioEndpoint(eRender, eConsole)?;
            let session_manager: IAudioSessionManager2 = device.Activate(CLSCTX_ALL, None)?;
            let session_enumerator = session_manager.GetSessionEnumerator()?;
            let count = session_enumerator.GetCount()?;

            // PID -> nome do exe, reaproveitando o mesmo snapshot usado em
            // find_discord_root_pid() — mais barato que resolver um por um.
            let exe_names = pid_to_exe_name_map();

            let mut sessions = Vec::new();
            for i in 0..count {
                let control = session_enumerator.GetSession(i)?;
                let Ok(control2) = control.cast::<IAudioSessionControl2>() else { continue };
                let pid = control2.GetProcessId().unwrap_or(0);
                if pid == 0 { continue; } // sessão "mix" do sistema, sem processo dono
                let is_active = control.GetState().map(|s| s == AudioSessionStateActive).unwrap_or(false);
                let exe_name = exe_names.get(&pid).cloned().unwrap_or_else(|| "?".to_string());
                sessions.push(AudioSessionInfo { pid, exe_name, is_active });
            }
            Ok(sessions)
        })();

        CoUninitialize();
        result.map_err(|e| Error::from_reason(format!("list_audio_sessions falhou: {e}")))
    }
}

fn pid_to_exe_name_map() -> std::collections::HashMap<u32, String> {
    let mut map = std::collections::HashMap::new();
    unsafe {
        let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else { return map };
        let mut entry = PROCESSENTRY32W::default();
        entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;
        let mut ok = Process32FirstW(snapshot, &mut entry).is_ok();
        while ok {
            let name_len = entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(entry.szExeFile.len());
            let name = String::from_utf16_lossy(&entry.szExeFile[..name_len]);
            map.insert(entry.th32ProcessID, name);
            ok = Process32NextW(snapshot, &mut entry).is_ok();
        }
        let _ = CloseHandle(snapshot);
    }
    map
}

fn activate_process_loopback(target_pid: u32, exclude: bool) -> WinResult<IAudioClient> {
    let mode = if exclude {
        PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE
    } else {
        PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE
    };

    let mut params = AUDIOCLIENT_ACTIVATION_PARAMS::default();
    params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
    params.Anonymous.ProcessLoopbackParams = AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
        TargetProcessId: target_pid,
        ProcessLoopbackMode: mode,
    };

    // PROPVARIANT do tipo VT_BLOB construído NA MÃO (não via
    // InitPropVariantFromBuffer — ver comentário grande no topo do arquivo
    // pra por que isso importa: aquela função cria VT_VECTOR|VT_UI1, não
    // VT_BLOB, e é a causa raiz do E_INVALIDARG que essa mesma ativação dava
    // antes). Usa o PROPVARIANT "cru" (windows::core::imp::PROPVARIANT, sem
    // Drop) — nunca existe um PROPVARIANT "dono" de verdade, então
    // PropVariantClear nunca tenta CoTaskMemFree num ponteiro de stack
    // (heap corruption). Reinterpretado como *const windows::core::PROPVARIANT
    // só na hora de chamar a API (mesmo layout — o wrapper é repr(transparent)).
    let mut propvariant: PROPVARIANT = unsafe { std::mem::zeroed() };
    propvariant.Anonymous.Anonymous.vt = VT_BLOB.0;
    propvariant.Anonymous.Anonymous.Anonymous.blob = windows::core::imp::BLOB {
        cbSize: size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32,
        pBlobData: &mut params as *mut _ as *mut u8,
    };

    // Ativação assíncrona no dispositivo virtual — o caminho oficial/validado
    // pela Microsoft pra process-loopback. Espera a conclusão via canal (o
    // completion handler roda numa thread COM interna, não a nossa).
    let (tx, rx) = channel::<WinResult<IActivateAudioInterfaceAsyncOperation>>();
    let handler: IActivateAudioInterfaceCompletionHandler =
        ActivationCompletionHandler { tx: std::sync::Mutex::new(Some(tx)) }.into();

    let dispatch_result = unsafe {
        ActivateAudioInterfaceAsync(
            VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
            &IAudioClient::IID as *const GUID,
            Some(&propvariant as *const PROPVARIANT as *const windows::core::PROPVARIANT),
            &handler,
        )
    };
    if let Err(e) = &dispatch_result {
        eprintln!("[sinal-audio] ActivateAudioInterfaceAsync (dispatch) falhou: {e:?}");
    }
    dispatch_result?;

    let operation = rx.recv().map_err(|_| windows::core::Error::from(HRESULT(-1)))??;
    let mut activate_hr = HRESULT(0);
    let mut activated_iface: Option<windows::core::IUnknown> = None;
    unsafe { operation.GetActivateResult(&mut activate_hr, &mut activated_iface) }
        .map_err(|e| { eprintln!("[sinal-audio] GetActivateResult (chamada) falhou: {e:?}"); e })?;
    activate_hr.ok().map_err(|e| { eprintln!("[sinal-audio] ativação retornou erro: {e:?}"); e })?;
    let audio_client: IAudioClient = activated_iface
        .and_then(|u| u.cast().ok())
        .ok_or_else(|| { eprintln!("[sinal-audio] ativação OK mas não deu pra obter IAudioClient"); windows::core::Error::from(HRESULT(-1)) })?;
    eprintln!("[sinal-audio] IAudioClient obtido via ActivateAudioInterfaceAsync, inicializando...");

    let mut format = WAVEFORMATEX::default();
    format.wFormatTag = WAVE_FORMAT_PCM as u16;
    format.nChannels = CHANNELS;
    format.nSamplesPerSec = SAMPLE_RATE;
    format.wBitsPerSample = BITS_PER_SAMPLE;
    format.nBlockAlign = CHANNELS * BITS_PER_SAMPLE / BITS_PER_BYTE as u16;
    format.nAvgBytesPerSec = SAMPLE_RATE * format.nBlockAlign as u32;

    unsafe {
        audio_client.Initialize(
            AUDCLNT_SHAREMODE_SHARED,
            AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
            0,
            0,
            &format,
            None,
        )
    }
    .map_err(|e| { eprintln!("[sinal-audio] AudioClient.Initialize falhou: {e:?}"); e })?;
    eprintln!("[sinal-audio] AudioClient inicializado com sucesso.");

    Ok(audio_client)
}

fn capture_loop(
    target_pid: u32,
    exclude: bool,
    stop_flag: Arc<AtomicBool>,
    tsfn: ThreadsafeFunction<Buffer, ErrorStrategy::CalleeHandled>,
    ready_tx: Sender<std::result::Result<(), String>>,
) {
    unsafe {
        if let Err(e) = CoInitializeEx(None, COINIT_MULTITHREADED).ok() {
            let _ = ready_tx.send(Err(format!("CoInitializeEx falhou: {e}")));
            return;
        }
    }

    let audio_client = match activate_process_loopback(target_pid, exclude) {
        Ok(c) => c,
        Err(e) => {
            let _ = ready_tx.send(Err(format!("ativação do loopback falhou: {e}")));
            unsafe { CoUninitialize() };
            return;
        }
    };

    let event_handle: HANDLE = match unsafe { CreateEventW(None, false, false, None) } {
        Ok(h) => h,
        Err(e) => {
            let _ = ready_tx.send(Err(format!("CreateEventW falhou: {e}")));
            unsafe { CoUninitialize() };
            return;
        }
    };

    let capture_client: IAudioCaptureClient = match unsafe { audio_client.GetService() } {
        Ok(c) => c,
        Err(e) => {
            let _ = ready_tx.send(Err(format!("GetService(IAudioCaptureClient) falhou: {e}")));
            unsafe { CloseHandle(event_handle).ok(); CoUninitialize() };
            return;
        }
    };

    if let Err(e) = unsafe { audio_client.SetEventHandle(event_handle) } {
        let _ = ready_tx.send(Err(format!("SetEventHandle falhou: {e}")));
        unsafe { CloseHandle(event_handle).ok(); CoUninitialize() };
        return;
    }

    if let Err(e) = unsafe { audio_client.Start() } {
        let _ = ready_tx.send(Err(format!("AudioClient.Start falhou: {e}")));
        unsafe { CloseHandle(event_handle).ok(); CoUninitialize() };
        return;
    }

    let _ = ready_tx.send(Ok(()));

    // 100ms de timeout em vez de INFINITE: precisamos checar stop_flag
    // periodicamente mesmo sem áudio novo chegando (ex: sistema mudo).
    while !stop_flag.load(Ordering::Relaxed) {
        let wait_result = unsafe { WaitForSingleObject(event_handle, 100) };
        if wait_result != WAIT_OBJECT_0 {
            continue; // timeout — só reavalia stop_flag
        }

        loop {
            let mut frames_available = 0u32;
            let packet_size = unsafe { capture_client.GetNextPacketSize() };
            let Ok(size) = packet_size else { break };
            if size == 0 {
                break;
            }

            let mut data_ptr = std::ptr::null_mut();
            let mut flags = 0u32;
            let get_buffer = unsafe {
                capture_client.GetBuffer(&mut data_ptr, &mut frames_available, &mut flags, None, None)
            };
            let Ok(()) = get_buffer else { break };

            let bytes_per_frame = (CHANNELS * BITS_PER_SAMPLE / BITS_PER_BYTE as u16) as usize;
            let byte_len = frames_available as usize * bytes_per_frame;
            if byte_len > 0 && !data_ptr.is_null() {
                let slice = unsafe { std::slice::from_raw_parts(data_ptr, byte_len) };
                let buffer = Buffer::from(slice.to_vec());
                tsfn.call(Ok(buffer), ThreadsafeFunctionCallMode::NonBlocking);
            }

            let _ = unsafe { capture_client.ReleaseBuffer(frames_available) };
        }
    }

    unsafe {
        let _ = audio_client.Stop();
        CloseHandle(event_handle).ok();
        CoUninitialize();
    }
}

#[napi]
pub struct AudioLoopback {
    stop_flag: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

#[napi]
impl AudioLoopback {
    #[napi(constructor)]
    pub fn new() -> Self {
        AudioLoopback { stop_flag: Arc::new(AtomicBool::new(false)), thread: None }
    }

    /// target_pid: PID a incluir ou excluir (junto com os processos filhos).
    /// exclude: true = captura tudo MENOS esse processo (ex: excluir o
    ///   Discord ao compartilhar a tela inteira). false = captura só esse
    ///   processo (ex: incluir só o jogo ao compartilhar uma janela
    ///   específica).
    /// callback: recebe Buffer com PCM 16-bit/48kHz/stereo a cada pacote.
    #[napi]
    pub fn start(
        &mut self,
        target_pid: u32,
        exclude: bool,
        callback: ThreadsafeFunction<Buffer, ErrorStrategy::CalleeHandled>,
    ) -> Result<()> {
        if self.thread.is_some() {
            return Err(Error::from_reason("captura já em andamento — chame stop() antes"));
        }

        self.stop_flag.store(false, Ordering::Relaxed);
        let stop_flag = self.stop_flag.clone();
        let (ready_tx, ready_rx) = channel();

        let handle = std::thread::spawn(move || {
            capture_loop(target_pid, exclude, stop_flag, callback, ready_tx);
        });

        // Espera a ativação terminar (ou falhar) antes de devolver o
        // controle pro JS — assim um erro de ativação vira uma Promise
        // rejeitada na hora, em vez de falhar silenciosamente numa thread
        // em segundo plano.
        match ready_rx.recv_timeout(std::time::Duration::from_secs(5)) {
            Ok(Ok(())) => {
                self.thread = Some(handle);
                Ok(())
            }
            Ok(Err(msg)) => {
                let _ = handle.join();
                Err(Error::from_reason(msg))
            }
            Err(_) => {
                let _ = handle.join();
                Err(Error::from_reason("timeout esperando a ativação do loopback"))
            }
        }
    }

    #[napi]
    pub fn stop(&mut self) {
        self.stop_flag.store(true, Ordering::Relaxed);
        if let Some(handle) = self.thread.take() {
            let _ = handle.join();
        }
    }
}
