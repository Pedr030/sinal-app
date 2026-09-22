// Caminho alternativo achado na doc oficial do IMMDevice::Activate: "Starting
// in Windows 10 Build 20348, callers activating an IAudioClient can set
// pActivationParams to a pointer to a AUDIOCLIENT_ACTIVATION_PARAMS to
// configure an audio client in loopback mode with a process filter."
//
// Ou seja: em vez de ActivateAudioInterfaceAsync() no dispositivo virtual
// (VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK), dá pra chamar o Activate()
// classico/sincrono da IMMDevice num dispositivo REAL, passando o mesmo
// AUDIOCLIENT_ACTIVATION_PARAMS como pActivationParams. Caminho de codigo
// bem diferente dentro do Windows -- vale testar se contorna o E_INVALIDARG.
use windows::core::Interface;
use windows::Win32::Media::Audio::{
    eConsole, eRender, IAudioClient, IMMDeviceEnumerator, MMDeviceEnumerator,
    AUDIOCLIENT_ACTIVATION_PARAMS, AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
    AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS, PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE,
};
use windows::Win32::System::Com::StructuredStorage::InitPropVariantFromBuffer;
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED};

fn main() {
    unsafe {
        CoInitializeEx(None, COINIT_MULTITHREADED).unwrap();

        println!("1) Pegando IMMDevice real (endpoint de renderizacao padrao)...");
        let enumerator: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).expect("CoCreateInstance falhou");
        let device = enumerator.GetDefaultAudioEndpoint(eRender, eConsole).expect("GetDefaultAudioEndpoint falhou");
        println!("   IMMDevice obtido.");

        println!("2) Montando AUDIOCLIENT_ACTIVATION_PARAMS (exclude mode, PID={})...", std::process::id());
        let mut params = AUDIOCLIENT_ACTIVATION_PARAMS::default();
        params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
        params.Anonymous.ProcessLoopbackParams = AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
            TargetProcessId: std::process::id(),
            ProcessLoopbackMode: PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE,
        };
        let propvariant = InitPropVariantFromBuffer(
            &params as *const _ as *const core::ffi::c_void,
            std::mem::size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32,
        ).expect("InitPropVariantFromBuffer falhou");

        println!("3) Chamando IMMDevice::Activate (API classica/sincrona, dispositivo REAL)...");
        let result: windows::core::Result<IAudioClient> = device.Activate(
            CLSCTX_ALL,
            Some(&propvariant as *const _ as *const _),
        );
        match result {
            Ok(_client) => {
                println!("   RESULTADO: SUCESSO! IMMDevice::Activate aceitou o process-loopback.");
                println!("   Isso significa que da pra contornar o bug usando esse caminho em vez de ActivateAudioInterfaceAsync.");
            }
            Err(e) => {
                println!("   RESULTADO: FALHOU tambem: {e:?}");
            }
        }
    }
}
