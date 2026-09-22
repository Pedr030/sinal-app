// Diagnóstico isolado: será que ActivateAudioInterfaceAsync em si (o
// mecanismo assíncrono) funciona nessa máquina pra ativação DEFAULT (sem
// blob de process-loopback), ou o problema é mais amplo que só o modo
// processo? Pega o device ID real do endpoint de renderização padrão via
// IMMDeviceEnumerator (API clássica, síncrona) e usa ESSE id — em vez da
// string virtual de process-loopback — na mesma chamada assíncrona.
use std::sync::mpsc::channel;
use windows::core::{implement, Interface, Result as WinResult, GUID, HRESULT};
use windows::Win32::Media::Audio::{
    ActivateAudioInterfaceAsync, eConsole, eRender, IActivateAudioInterfaceAsyncOperation,
    IActivateAudioInterfaceCompletionHandler, IActivateAudioInterfaceCompletionHandler_Impl,
    IAudioClient, IMMDeviceEnumerator, MMDeviceEnumerator,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, IAgileObject, CLSCTX_ALL, COINIT_MULTITHREADED,
};

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
    unsafe {
        CoInitializeEx(None, COINIT_MULTITHREADED).unwrap();

        println!("1) Pegando o device ID real do endpoint de renderizacao padrao...");
        let enumerator: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).expect("CoCreateInstance(MMDeviceEnumerator) falhou");
        let device = enumerator.GetDefaultAudioEndpoint(eRender, eConsole).expect("GetDefaultAudioEndpoint falhou");
        let id_pwstr = device.GetId().expect("GetId falhou");
        let device_id = id_pwstr.to_string().unwrap();
        println!("   device id: {device_id}");

        println!("2) Chamando ActivateAudioInterfaceAsync com ativacao DEFAULT (sem blob de processo)...");
        let (tx, rx) = channel::<WinResult<IActivateAudioInterfaceAsyncOperation>>();
        let handler: IActivateAudioInterfaceCompletionHandler = Handler { tx: std::sync::Mutex::new(Some(tx)) }.into();

        let device_id_pcw = windows::core::PCWSTR::from_raw(id_pwstr.0);
        let dispatch_result = ActivateAudioInterfaceAsync(device_id_pcw, &IAudioClient::IID as *const GUID, None, &handler);
        match &dispatch_result {
            Ok(_) => println!("   ActivateAudioInterfaceAsync (dispatch) OK"),
            Err(e) => { println!("   ActivateAudioInterfaceAsync (dispatch) FALHOU: {e:?}"); return; }
        }
        drop(dispatch_result);

        let operation = rx.recv().unwrap().expect("callback devolveu erro");
        let mut hr_result = HRESULT(0);
        let mut interface: Option<windows::core::IUnknown> = None;
        operation.GetActivateResult(&mut hr_result, &mut interface).expect("GetActivateResult (chamada) falhou");
        println!("3) GetActivateResult hr = {:?}", hr_result);
        match hr_result.ok() {
            Ok(()) => println!("   RESULTADO: SUCESSO — ativacao DEFAULT funciona nessa maquina."),
            Err(e) => println!("   RESULTADO: FALHOU tambem: {e:?}"),
        }
    }
}
