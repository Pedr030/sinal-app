// Captura de áudio do Windows por processo (WASAPI "process loopback"),
// incluindo OU excluindo a árvore de um PID específico. Escrito do zero em
// cima da amostra oficial da Microsoft (Samples/ApplicationLoopback do repo
// microsoft/Windows-classic-samples) — ver HANDOFF.md pra por que isso é
// código próprio em vez de um pacote de terceiro pouco maduro.
//
// Simplificação em relação à amostra original: a amostra usa Media
// Foundation (MFPutWorkItem/IMFAsyncCallback) só como mecanismo de fila
// assíncrona — aqui uma thread dedicada com WaitForSingleObject faz o mesmo
// trabalho, sem precisar inicializar o MF inteiro.
#![deny(unsafe_op_in_unsafe_fn)]

use std::mem::size_of;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ErrorStrategy, ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;

use windows::core::{implement, Interface, Result as WinResult, GUID, HRESULT};
use windows::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0};
use windows::Win32::Media::Audio::{
    ActivateAudioInterfaceAsync, IActivateAudioInterfaceAsyncOperation,
    IActivateAudioInterfaceCompletionHandler, IActivateAudioInterfaceCompletionHandler_Impl,
    IAudioCaptureClient, IAudioClient, AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
    AUDCLNT_STREAMFLAGS_EVENTCALLBACK, AUDCLNT_STREAMFLAGS_LOOPBACK,
    AUDIOCLIENT_ACTIVATION_PARAMS, AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
    AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS, PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE,
    PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE, VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
    WAVEFORMATEX, WAVE_FORMAT_PCM,
};
use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, IAgileObject, COINIT_MULTITHREADED};
use windows::Win32::System::Com::StructuredStorage::InitPropVariantFromBuffer;
use windows::Win32::System::Threading::{CreateEventW, WaitForSingleObject};

const BITS_PER_BYTE: u32 = 8;
// Formato fixo — 16-bit PCM, 48kHz, estéreo. AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
// (abaixo) deixa o próprio Windows converter, então não precisamos negociar
// o formato nativo do dispositivo.
const SAMPLE_RATE: u32 = 48000;
const CHANNELS: u16 = 2;
const BITS_PER_SAMPLE: u16 = 16;

// Handler de conclusão do ActivateAudioInterfaceAsync — a API é
// intrinsecamente assíncrona (roda numa thread MTA do sistema), então a
// gente implementa essa interface COM só pra devolver o resultado por um
// canal (mpsc) pra thread de captura, que fica bloqueada esperando.
// IAgileObject (interface marcadora, sem métodos) é necessária aqui: a
// Microsoft documenta que o completion handler passado pra
// ActivateAudioInterfaceAsync precisa ser "agile" (livre de apartamento) pra
// não travar quando o sistema chama ActivateCompleted de dentro da thread MTA
// dele. O equivalente em C++/WRL é FtmBase (RuntimeClassFlags<..., FtmBase>)
// na amostra original — sem isso aqui, a contraparte Rust ficava incompleta.
#[implement(IActivateAudioInterfaceCompletionHandler, IAgileObject)]
struct CompletionHandler {
    tx: Mutex<Option<Sender<WinResult<IActivateAudioInterfaceAsyncOperation>>>>,
}

// Marcador puro, sem métodos — só precisa "existir" pra sinalizar que o
// objeto é agile (ver comentário acima da struct).
impl windows::Win32::System::Com::IAgileObject_Impl for CompletionHandler_Impl {}

impl IActivateAudioInterfaceCompletionHandler_Impl for CompletionHandler_Impl {
    fn ActivateCompleted(
        &self,
        activate_operation: Option<&IActivateAudioInterfaceAsyncOperation>,
    ) -> WinResult<()> {
        if let Some(tx) = self.tx.lock().unwrap().take() {
            let result = activate_operation
                .cloned()
                .ok_or_else(|| windows::core::Error::from(HRESULT(-1)));
            let _ = tx.send(result);
        }
        Ok(())
    }
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

    // PROPVARIANT do tipo VT_BLOB apontando pro struct acima — equivalente ao
    // que a amostra em C++ monta na mão (activateParams.vt = VT_BLOB; ...),
    // só que via InitPropVariantFromBuffer (propsys.dll), a função oficial do
    // Windows pra isso — evita mexer direto nos campos da union.
    eprintln!(
        "[sinal-audio] AUDIOCLIENT_ACTIVATION_PARAMS: size={} bytes, ActivationType={}, TargetProcessId={}, ProcessLoopbackMode={}, raw_bytes={:02x?}",
        size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>(),
        params.ActivationType.0,
        unsafe { params.Anonymous.ProcessLoopbackParams.TargetProcessId },
        unsafe { params.Anonymous.ProcessLoopbackParams.ProcessLoopbackMode.0 },
        unsafe {
            std::slice::from_raw_parts(&params as *const _ as *const u8, size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>())
        }
    );
    let propvariant = unsafe {
        InitPropVariantFromBuffer(
            &params as *const _ as *const core::ffi::c_void,
            size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32,
        )?
    };

    let (tx, rx) = channel::<WinResult<IActivateAudioInterfaceAsyncOperation>>();
    let handler: IActivateAudioInterfaceCompletionHandler = CompletionHandler {
        tx: Mutex::new(Some(tx)),
    }
    .into();

    eprintln!("[sinal-audio] chamando ActivateAudioInterfaceAsync...");
    let _operation: IActivateAudioInterfaceAsyncOperation = unsafe {
        ActivateAudioInterfaceAsync(
            VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
            &IAudioClient::IID as *const GUID,
            Some(&propvariant as *const _ as *const _),
            &handler,
        )
    }
    .map_err(|e| { eprintln!("[sinal-audio] ActivateAudioInterfaceAsync falhou: {e:?}"); e })?;
    eprintln!("[sinal-audio] ActivateAudioInterfaceAsync ok, esperando callback...");

    // Bloqueia a thread de captura (não a de JS) até a ativação terminar —
    // mesma estratégia de m_hActivateCompleted.wait() na amostra original.
    let operation = rx
        .recv()
        .map_err(|_| windows::core::Error::from(HRESULT(-1)))?
        .map_err(|e| { eprintln!("[sinal-audio] callback devolveu erro: {e:?}"); e })?;
    eprintln!("[sinal-audio] callback recebido, chamando GetActivateResult...");

    let mut hr_result = HRESULT(0);
    let mut interface: Option<windows::core::IUnknown> = None;
    unsafe { operation.GetActivateResult(&mut hr_result, &mut interface) }
        .map_err(|e| { eprintln!("[sinal-audio] GetActivateResult (chamada) falhou: {e:?}"); e })?;
    eprintln!("[sinal-audio] GetActivateResult hr={:?}", hr_result);
    hr_result.ok().map_err(|e| { eprintln!("[sinal-audio] hr_result interno indica erro: {e:?}"); e })?;
    let unknown = interface.ok_or_else(|| windows::core::Error::from(HRESULT(-1)))?;
    let audio_client: IAudioClient = unknown.cast()?;
    eprintln!("[sinal-audio] IAudioClient obtido, inicializando...");

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
