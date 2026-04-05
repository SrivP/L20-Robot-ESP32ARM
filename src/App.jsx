import { useCallback, useEffect, useRef, useState } from 'react'
import './App.css'

// ── WebSocket endpoint ────────────────────────────────────────────────────────
const WS_URL = 'ws://192.168.4.1:81'

// ── Voice command rules (Web Speech API transcript → firmware command) ────────
const VOICE_RULES = [
  { patterns: [/\b(go home|home position|reset position)\b/i], command: 'VOICE_HOME'  },
  { patterns: [/\bsave( position| pose)?\b/i],                  command: 'SAVE'         },
  { patterns: [/\b(run|play|start sequence)\b/i],               command: 'RUN'          },
  { patterns: [/\bpause\b/i],                                   command: 'PAUSE'        },
  { patterns: [/\b(stop|reset|clear)\b/i],                      command: 'RESET'        },
  { patterns: [/\b(open gripper|open claw|release|drop)\b/i],   command: 'VOICE_OPEN'   },
  { patterns: [/\b(close gripper|close claw|grab|grip)\b/i],    command: 'VOICE_CLOSE'  },
  { patterns: [/\b(pick up|grab object)\b/i],                   command: 'VOICE_PICK'   },
  { patterns: [/\b(place|put down|drop off)\b/i],               command: 'VOICE_PLACE'  },
  { patterns: [/\b(turn|rotate|waist)\s*(left)\b/i],   joint: 1, dir: -15 },
  { patterns: [/\b(turn|rotate|waist)\s*(right)\b/i],  joint: 1, dir: +15 },
  { patterns: [/\b(shoulder|upper arm)\s*(up|raise)\b/i],   joint: 2, dir: +15 },
  { patterns: [/\b(shoulder|upper arm)\s*(down|lower)\b/i], joint: 2, dir: -15 },
  { patterns: [/\belbow\s*(up|extend|raise)\b/i],  joint: 3, dir: +15 },
  { patterns: [/\belbow\s*(down|bend)\b/i],         joint: 3, dir: -15 },
  { patterns: [/\bwrist\s*(up)\b/i],                joint: 4, dir: +15 },
  { patterns: [/\bwrist\s*(down)\b/i],              joint: 4, dir: -15 },
  { patterns: [/\b(spin|wrist)\s*(left|counter)\b/i],    joint: 5, dir: -15 },
  { patterns: [/\b(spin|wrist)\s*(right|clockwise)\b/i], joint: 5, dir: +15 },
]

function resolveVoiceCommand(transcript, currentAngles) {
  const lower = transcript.toLowerCase().trim()
  for (const rule of VOICE_RULES) {
    if (!rule.patterns.some(p => p.test(lower))) continue
    if (rule.command) return { cmd: rule.command }
    if (rule.joint !== undefined) {
      const key = `s${rule.joint}`
      const next = Math.min(180, Math.max(0, (currentAngles[key] ?? 90) + rule.dir))
      return { cmd: `s${rule.joint}${next}`, updatedAngles: { ...currentAngles, [key]: next } }
    }
  }
  return null
}

// ── Joint config ──────────────────────────────────────────────────────────────
const JOINTS = [
  { id: 1, label: 'Waist',       min: 0, max: 180 },
  { id: 2, label: 'Shoulder',    min: 0, max: 180 },
  { id: 3, label: 'Elbow',       min: 0, max: 180 },
  { id: 4, label: 'Wrist Pitch', min: 0, max: 180 },
  { id: 5, label: 'Wrist Roll',  min: 0, max: 180 },
  { id: 6, label: 'Gripper',     min: 0, max: 180 },
]

export default function App() {
  const wsRef            = useRef(null)
  const recognitionRef   = useRef(null)
  const sliderTimers     = useRef({})

  const [connected,   setConnected]   = useState(false)
  const [wsStatus,    setWsStatus]    = useState('disconnected') // disconnected | connecting | connected | error
  const [log,         setLog]         = useState([{ t: 'System ready — connect to RobotArm6DOF WiFi first', k: 'sys' }])
  const [voiceActive, setVoiceActive] = useState(false)
  const [transcript,  setTranscript]  = useState('')
  const [voiceSupported, setVoiceSupported] = useState(false)
  const [angles,      setAngles]      = useState({ s1: 90, s2: 150, s3: 35, s4: 140, s5: 85, s6: 80 })
  const [speed,       setSpeed]       = useState(20)

  const anglesRef = useRef(angles)
  useEffect(() => { anglesRef.current = angles }, [angles])

  // ── Logging ──────────────────────────────────────────────────────────────────
  const pushLog = useCallback((text, kind = 'info') => {
    setLog(prev => [{ t: text, k: kind, id: Date.now() + Math.random() }, ...prev].slice(0, 40))
  }, [])

  // ── WebSocket ─────────────────────────────────────────────────────────────────
  const sendRaw = useCallback((cmd) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(cmd)
      pushLog(`▶ ${cmd}`, 'send')
    } else {
      pushLog('⚠ Not connected', 'warn')
    }
  }, [pushLog])

  const connectWS = useCallback(() => {
    if (wsRef.current) wsRef.current.close()
    setWsStatus('connecting')
    pushLog('Connecting to ' + WS_URL + '…', 'sys')

    const ws = new WebSocket(WS_URL)
    wsRef.current = ws

    ws.onopen = () => {
      setConnected(true)
      setWsStatus('connected')
      pushLog('✅ Connected to robot', 'ok')
    }
    ws.onmessage = (e) => {
      pushLog('◀ ' + e.data, 'recv')
    }
    ws.onerror = () => {
      setWsStatus('error')
      pushLog('✗ Connection error — is the ESP32 on?', 'error')
    }
    ws.onclose = () => {
      setConnected(false)
      setWsStatus('disconnected')
      pushLog('🔌 Disconnected', 'sys')
    }
  }, [pushLog])

  const disconnectWS = useCallback(() => {
    wsRef.current?.close()
  }, [])

  // ── Sliders ───────────────────────────────────────────────────────────────────
  const onSliderChange = (joint, value) => {
    const angle = Math.round(value)
    setAngles(prev => ({ ...prev, [`s${joint}`]: angle }))
    clearTimeout(sliderTimers.current[joint])
    sliderTimers.current[joint] = setTimeout(() => sendRaw(`s${joint}${angle}`), 80)
  }

  const onSpeedChange = (e) => {
    const ms = Number(e.target.value)
    setSpeed(ms)
    clearTimeout(sliderTimers.current['ss'])
    sliderTimers.current['ss'] = setTimeout(() => sendRaw(`ss${ms}`), 80)
  }

  // ── Voice ─────────────────────────────────────────────────────────────────────
  useEffect(() => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SpeechRecognition) return
    setVoiceSupported(true)

    const rec = new SpeechRecognition()
    rec.lang           = 'en-US'
    rec.continuous     = false
    rec.interimResults = false

    rec.onresult = (e) => {
      const raw = e.results[0][0].transcript
      setTranscript(raw)
      const result = resolveVoiceCommand(raw, anglesRef.current)
      if (result) {
        sendRaw(result.cmd)
        if (result.updatedAngles) setAngles(result.updatedAngles)
        pushLog(`🎤 "${raw}" → ${result.cmd}`, 'voice')
      } else {
        pushLog(`🎤 Unrecognised: "${raw}"`, 'warn')
      }
    }

    rec.onend  = () => setVoiceActive(false)
    rec.onerror = (e) => {
      pushLog('Voice error: ' + e.error, 'error')
      setVoiceActive(false)
    }

    recognitionRef.current = rec
  }, [sendRaw, pushLog])

  const toggleVoice = () => {
    const rec = recognitionRef.current
    if (!rec) return
    if (voiceActive) {
      rec.stop()
      setVoiceActive(false)
    } else {
      setTranscript('')
      rec.start()
      setVoiceActive(true)
      pushLog('🎤 Listening…', 'sys')
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────────
  const statusColor = { connected: '#00ff9d', connecting: '#fbbf24', disconnected: '#ff4757', error: '#ff4757' }[wsStatus]

  return (
    <div className="app">
      <header className="app-header">
        <div className="header-left">
          <span className="header-logo">⬡</span>
          <div>
            <h1>ARM CTRL</h1>
            <p className="header-sub">6-DOF · ESP32 · PCA9685</p>
          </div>
        </div>
        <div className="header-right">
          <span className="status-dot" style={{ background: statusColor }} />
          <span className="status-label">{wsStatus.toUpperCase()}</span>
        </div>
      </header>

      <main className="app-main">
        {/* ── Left column ── */}
        <div className="col col-left">

          {/* Connection */}
          <section className="panel">
            <h2 className="panel-title">CONNECTION</h2>
            <p className="panel-hint">
              1. Join WiFi <strong>RobotArm6DOF</strong> (pw: robotarm123)<br />
              2. Click Connect
            </p>
            <button
              className={`btn ${connected ? 'btn-danger' : 'btn-primary'}`}
              onClick={connected ? disconnectWS : connectWS}
              disabled={wsStatus === 'connecting'}
            >
              {wsStatus === 'connecting' ? 'CONNECTING…' : connected ? 'DISCONNECT' : 'CONNECT'}
            </button>
          </section>

          {/* Voice */}
          <section className="panel">
            <h2 className="panel-title">VOICE CONTROL</h2>
            {voiceSupported ? (
              <>
                <p className="panel-hint">
                  "turn left / right" · "shoulder up / down" · "elbow up / down"<br />
                  "wrist up / down" · "open / close gripper"<br />
                  "pick" · "place" · "go home" · "save" · "run" · "stop"
                </p>
                <button
                  className={`btn ${voiceActive ? 'btn-danger' : 'btn-voice'}`}
                  onClick={toggleVoice}
                  disabled={!connected}
                >
                  <span className={`mic-icon ${voiceActive ? 'mic-active' : ''}`}>●</span>
                  {voiceActive ? 'LISTENING…' : 'START VOICE'}
                </button>
                {transcript && (
                  <div className="transcript">"{transcript}"</div>
                )}
              </>
            ) : (
              <p className="panel-hint warn">
                Web Speech API not supported in this browser.<br />
                Use Chrome or Edge.
              </p>
            )}
          </section>

          {/* Sequence */}
          <section className="panel">
            <h2 className="panel-title">SEQUENCE</h2>
            <div className="seq-grid">
              {[
                { label: 'SAVE',  cmd: 'SAVE',  cls: 'btn-blue'   },
                { label: 'RUN',   cmd: 'RUN',   cls: 'btn-primary' },
                { label: 'PAUSE', cmd: 'PAUSE', cls: 'btn-yellow'  },
                { label: 'RESET', cmd: 'RESET', cls: 'btn-danger'  },
              ].map(({ label, cmd, cls }) => (
                <button
                  key={cmd}
                  className={`btn ${cls}`}
                  onClick={() => sendRaw(cmd)}
                  disabled={!connected}
                >
                  {label}
                </button>
              ))}
            </div>
          </section>
        </div>

        {/* ── Right column ── */}
        <div className="col col-right">

          {/* Sliders */}
          <section className="panel">
            <h2 className="panel-title">MANUAL CONTROL</h2>
            <div className="sliders">
              {JOINTS.map(({ id, label }) => (
                <div className="slider-row" key={id}>
                  <div className="slider-meta">
                    <span className="slider-label">{label}</span>
                    <span className="slider-value">{angles[`s${id}`]}°</span>
                  </div>
                  <div className="slider-track-wrap">
                    <input
                      type="range"
                      min={0}
                      max={180}
                      value={angles[`s${id}`]}
                      onChange={e => onSliderChange(id, Number(e.target.value))}
                      disabled={!connected}
                      className="slider"
                    />
                    <div
                      className="slider-fill"
                      style={{ width: `${(angles[`s${id}`] / 180) * 100}%` }}
                    />
                  </div>
                </div>
              ))}

              {/* Speed */}
              <div className="slider-row speed-row">
                <div className="slider-meta">
                  <span className="slider-label">Speed</span>
                  <span className="slider-value speed-value">{speed} ms/°</span>
                </div>
                <div className="slider-track-wrap">
                  <input
                    type="range"
                    min={5}
                    max={100}
                    value={speed}
                    onChange={onSpeedChange}
                    disabled={!connected}
                    className="slider slider-speed"
                  />
                  <div
                    className="slider-fill slider-fill-speed"
                    style={{ width: `${((speed - 5) / 95) * 100}%` }}
                  />
                </div>
              </div>
            </div>
          </section>

          {/* Log */}
          <section className="panel panel-log">
            <h2 className="panel-title">LOG</h2>
            <div className="log-scroll">
              {log.map((entry, i) => (
                <div key={entry.id ?? i} className={`log-line log-${entry.k}`}>
                  {entry.t}
                </div>
              ))}
            </div>
          </section>
        </div>
      </main>
    </div>
  )
}
