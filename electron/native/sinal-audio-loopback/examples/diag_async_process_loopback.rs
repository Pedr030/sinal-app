// Retomando a investigação de HANDOFF.md §15.7: tenta o caminho OFICIAL da
// amostra da Microsoft (ActivateAudioInterfaceAsync no dispositivo virtual
// VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, com o blob de AUDIOCLIENT_ACTIVATION_PARAMS)
// de novo, agora que sabemos que o caminho síncrono (IMMDevice::Activate)
// provavelmente nunca filtrou nada de verdade. target_pid e exclude(0/1) via argv.
use std::sync::mpsc::channel;
use windows::core::{implement, Interface, Result as WinResult, GUID, HRESULT};
use windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;
use windows::Win32::Media::Audio::{
    eConsole, eRender, ActivateAudioInterfaceAsync, IActivateAudioInterfaceAsyncOperation,
    IActivateAudioInterfaceCompletionHandler, IActivateAudioInterfaceCompletionHandler_Impl,
    IAudioClient, IMMDeviceEnumerator, MMDeviceEnumerator, AUDIOCLIENT_ACTIVATION_PARAMS,
    AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK, AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS,
    PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE, PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE,
    VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
};
use windows::Win32::System::Com::StructuredStorage::InitPropVariantFromBuffer;
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, IAgileObject, STGM_READ, CLSCTX_ALL, COINIT_MULTITHREADED};

#[implement(IActivateAudioInterfaceCompletionHandler, IAgileObject)]
struct Handler {
    tx: std::sync::Mutex<Option<std::sync::mpsc::Sender<WinResult<IActivateAudioInterfaceAsyncOperation>>>>,
}
impl windows::Win32::System::Com::IAgileObject_Impl for Handler_Impl {}
impl IActivateAudioInterfaceCompletionHandler_Impl for Handler_Impl {
    fn ActivateCompleted(&self, op: Option<&IActivateAudioInterfaceAsyncOperation>) -> WinResult<()> {
        if let Some(tx) = self.tx.lock().unwrap().take() {
            let _ = tx.send(op.cloned().ok_or_else(|| windows::core::Error::from(HRESULT(-1))));
        }
        Ok(())
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let target_pid: u32 = args.get(1).and_then(|s| s.parse().ok()).unwrap_or(std::process::id());
    let exclude: bool = args.get(2).map(|s| s == "1").unwrap_or(true);
    // pid=0 -> testa o device virtual SEM nenhum blob de process-loopback (pActivationParams = None),
    // pra saber se o problema é o blob especificamente ou a ativação nesse device virtual em geral.
    let no_params = target_pid == 0;

    unsafe {
        CoInitializeEx(None, COINIT_MULTITHREADED).unwrap();

        let enumerator: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).expect("CoCreateInstance falhou");
        let device = enumerator.GetDefaultAudioEndpoint(eRender, eConsole).expect("GetDefaultAudioEndpoint falhou");
        let store = device.OpenPropertyStore(STGM_READ).expect("OpenPropertyStore falhou");
        let name_pv = store.GetValue(&PKEY_Device_FriendlyName).expect("GetValue(FriendlyName) falhou");
        println!("dispositivo de renderizacao padrao: {}", name_pv.to_string());

        println!("target_pid={target_pid} exclude={exclude} no_params={no_params}");
        let mode = if exclude { PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE } else { PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE };
        let mut params = AUDIOCLIENT_ACTIVATION_PARAMS::default();
        params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
        params.Anonymous.ProcessLoopbackParams = AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
            TargetProcessId: target_pid,
            ProcessLoopbackMode: mode,
        };
        let propvariant = InitPropVariantFromBuffer(
            &params as *const _ as *const core::ffi::c_void,
            std::mem::size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32,
        ).expect("InitPropVariantFromBuffer falhou");

        println!("Chamando ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, ...)...");
        let (tx, rx) = channel::<WinResult<IActivateAudioInterfaceAsyncOperation>>();
        let handler: IActivateAudioInterfaceCompletionHandler = Handler { tx: std::sync::Mutex::new(Some(tx)) }.into();

        let dispatch_result = ActivateAudioInterfaceAsync(
            VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
            &IAudioClient::IID as *const GUID,
            if no_params { None } else { Some(&propvariant as *const _) },
            &handler,
        );
        match &dispatch_result {
            Ok(_) => println!("  dispatch OK"),
            Err(e) => { println!("  dispatch FALHOU: {e:?}"); return; }
        }
        drop(dispatch_result);

        let operation = rx.recv().unwrap().expect("callback devolveu erro");
        let mut hr_result = HRESULT(0);
        let mut interface: Option<windows::core::IUnknown> = None;
        operation.GetActivateResult(&mut hr_result, &mut interface).expect("GetActivateResult (chamada) falhou");
        println!("GetActivateResult hr = {:?}", hr_result);
        match hr_result.ok() {
            Ok(()) => println!("RESULTADO: SUCESSO -- ativacao assincrona com process-loopback funcionou!"),
            Err(e) => println!("RESULTADO: FALHOU: {e:?}"),
        }
    }
}
