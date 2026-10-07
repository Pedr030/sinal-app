// Mistura do áudio isolado do app desktop (HANDOFF §15 e §47). Roda na THREAD DE ÁUDIO (AudioWorklet),
// não na página: antes a mistura era um ScriptProcessorNode na thread principal, em blocos de ~43 ms, e
// qualquer engasgo da página (um jogo pesado na máquina basta) virava estalo audível na transmissão.
//
// A página só repassa os pedaços de PCM que chegam do processo principal (postMessage); aqui eles viram
// filas por origem (PID) e são somados. O formato é o fixo do addon nativo: PCM 16-bit LE intercalado,
// estéreo, 48 kHz.
const TARGET_QUEUED_FRAMES = 4800;  // ~100 ms: pra onde a fila volta quando passa do limite
const MAX_QUEUED_FRAMES = 12000;    // ~250 ms: passou disso, descarta o excesso MAIS ANTIGO (atraso sempre limitado)
// Reserva (jitter buffer) ADAPTATIVA, por origem: só começa a tocar quando junta a reserva (os pedaços chegam
// em rajadas; sem ela, cada intervalo vira um furo). Começa pequena (pouco atraso do som em relação ao
// vídeo); cada vez que a fila esvazia no meio do som (a página engasgou mais que a reserva) ela cresce, até
// o teto, e depois de um bom tempo sem furo volta a diminuir. Assim só o PC que realmente engasga paga atraso.
const PREBUFFER_MIN = 2880;         // ~60 ms
const PREBUFFER_MAX = 9600;         // ~200 ms
const PREBUFFER_GROW = 1920;        // +40 ms a cada furo
const PREBUFFER_SHRINK = 480;       // -10 ms ...
const SHRINK_AFTER_FRAMES = 48000 * 30; // ... a cada 30 s tocando sem furo

class MixerCore {
  constructor(){
    this.sources = new Map(); // pid -> { queue: [{left,right}], readIndex, queuedFrames, playing, prebuffer, calmFrames }
  }

  // bytes: Uint8Array de PCM s16le estéreo intercalado
  push(pid, bytes){
    const frames = Math.floor(bytes.length / 4);
    if(!frames) return;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const left = new Float32Array(frames);
    const right = new Float32Array(frames);
    for(let i = 0; i < frames; i++){
      left[i] = view.getInt16(i * 4, true) / 32768;
      right[i] = view.getInt16(i * 4 + 2, true) / 32768;
    }
    let s = this.sources.get(pid);
    if(!s){ s = { queue: [], readIndex: 0, queuedFrames: 0, playing: false, prebuffer: PREBUFFER_MIN, calmFrames: 0 }; this.sources.set(pid, s); }
    s.queue.push({ left, right });
    s.queuedFrames += frames;
    // com a reserva grande o teto também sobe (a fila precisa caber a reserva + folga)
    if(s.queuedFrames > Math.max(MAX_QUEUED_FRAMES, s.prebuffer + 4800)) this._trim(s);
  }

  remove(pid){ this.sources.delete(pid); }

  _trim(s){
    let excess = s.queuedFrames - Math.max(TARGET_QUEUED_FRAMES, s.prebuffer + 1920);
    while(excess > 0 && s.queue.length){
      const remaining = s.queue[0].left.length - s.readIndex;
      if(remaining <= excess){
        s.queue.shift();
        s.readIndex = 0;
        s.queuedFrames -= remaining;
        excess -= remaining;
      } else {
        s.readIndex += excess;
        s.queuedFrames -= excess;
        excess = 0;
      }
    }
  }

  // Preenche left/right (um bloco de saída) com a soma das origens ativas.
  render(left, right){
    left.fill(0);
    right.fill(0);
    const n = left.length;
    for(const s of this.sources.values()){
      if(!s.playing){
        if(s.queuedFrames < s.prebuffer) continue;
        s.playing = true;
      }
      for(let i = 0; i < n; i++){
        if(!s.queue.length){ // furo: a fila esvaziou. Aumenta a reserva e volta a juntar antes de tocar
          s.playing = false;
          s.prebuffer = Math.min(PREBUFFER_MAX, s.prebuffer + PREBUFFER_GROW);
          s.calmFrames = 0;
          break;
        }
        const chunk = s.queue[0];
        left[i] += chunk.left[s.readIndex];
        right[i] += chunk.right[s.readIndex];
        s.readIndex++;
        s.queuedFrames--;
        if(s.readIndex >= chunk.left.length){ s.queue.shift(); s.readIndex = 0; }
        if(++s.calmFrames >= SHRINK_AFTER_FRAMES){ // muito tempo sem furo: devolve um pouco de atraso
          s.calmFrames = 0;
          s.prebuffer = Math.max(PREBUFFER_MIN, s.prebuffer - PREBUFFER_SHRINK);
        }
      }
    }
    // Somar várias origens pode passar de ±1.0: limita (em vez de normalizar, que mudaria o volume toda
    // vez que uma origem entra ou sai).
    for(let i = 0; i < n; i++){
      if(left[i] > 1) left[i] = 1; else if(left[i] < -1) left[i] = -1;
      if(right[i] > 1) right[i] = 1; else if(right[i] < -1) right[i] = -1;
    }
  }
}

if(typeof AudioWorkletProcessor === 'function' && typeof registerProcessor === 'function'){
  class MixerProcessor extends AudioWorkletProcessor {
    constructor(){
      super();
      this.core = new MixerCore();
      this.port.onmessage = (event) => {
        const m = event.data;
        if(!m) return;
        if(m.type === 'chunk') this.core.push(m.pid, new Uint8Array(m.buf));
        else if(m.type === 'remove') this.core.remove(m.pid);
      };
    }
    process(inputs, outputs){
      const out = outputs[0];
      if(out && out.length >= 2) this.core.render(out[0], out[1]);
      else if(out && out.length === 1) out[0].fill(0);
      return true; // fica vivo pra sempre; quem fecha é o AudioContext ao parar de compartilhar
    }
  }
  registerProcessor('sinal-mixer', MixerProcessor);
}
