import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { useWebHaptics } from 'web-haptics/react';
import { useTranslation } from 'react-i18next';
import { useIntro } from '../context/IntroContext';

interface IntroAnimationProps {
  onAnimationComplete: () => void;
}

interface Element {
  symbol: string;
  number: number;
  name: string;
  mass: string;
}

const ELEMENTS: Element[] = [
  { symbol: 'Mo', number: 42, name: 'Molybdène', mass: '95.95' },
  { symbol: 'O', number: 8, name: 'Oxygène', mass: '15.999' },
  { symbol: 'V', number: 23, name: 'Vanadium', mass: '50.942' },
  { symbol: 'I', number: 53, name: 'Iode', mass: '126.90' },
];

const CARD_ANIMS = ['slamIn', 'bubbleUp', 'dropIn', 'materialize'] as const;

function makeParticles(count: number, compact = false) {
  const n = compact ? Math.ceil(count * 0.5) : count;
  return Array.from({ length: n }, () => ({
    angle: Math.random() * Math.PI * 2,
    dist: (compact ? 25 : 60) + Math.random() * (compact ? 65 : 150),
    size: (compact ? 1.5 : 2) + Math.random() * (compact ? 3 : 5),
    delay: Math.random() * 0.25,
    dur: 0.5 + Math.random() * 0.7,
  }));
}

// Pre-generated sparkle positions (stable, no Math.random in render)
const SPARKLE_POSITIONS = Array.from({ length: 8 }, (_, i) => ({
  x: 15 + ((i * 37 + 13) % 70),
  y: 15 + ((i * 53 + 7) % 70),
  delay: 0.8 + i * 0.08,
}));

const IntroAnimation: React.FC<IntroAnimationProps> = ({ onAnimationComplete }) => {
  const { t } = useTranslation();
  const [step, setStep] = useState(-1);
  const [flash, setFlash] = useState<string | null>(null);
  const [shaking, setShaking] = useState(false);
  const { skipIntro } = useIntro();

  const { trigger: haptic } = useWebHaptics();
  const isMobile = useMemo(() => typeof window !== 'undefined' && window.innerWidth < 640, []);

  // Stable particle sets — fewer & closer on mobile
  const allParticles = useMemo(() => ({
    0: makeParticles(24, isMobile),
    1: makeParticles(16, isMobile),
    2: makeParticles(22, isMobile),
    3: makeParticles(18, isMobile),
    4: makeParticles(35, isMobile),
  }), [isMobile]);

  const finish = useCallback(() => {
    document.body.style.overflow = '';
    onAnimationComplete();
  }, [onAnimationComplete]);

  const triggerFlash = useCallback((color: string, dur = 300) => {
    setFlash(color);
    setTimeout(() => setFlash(null), dur);
  }, []);

  const triggerShake = useCallback((dur = 400) => {
    setShaking(true);
    setTimeout(() => setShaking(false), dur);
  }, []);

  // Lock scroll immediately
  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, []);

  // Strong vibration patterns (ms) — [vibrate, pause, vibrate, ...]
  const VIBE = {
    tap:      [30],
    slam:     [100, 30, 150],          // Mo, V — heavy double impact
    medium:   [80],                     // O — single pulse
    soft:     [50],                     // I — gentle
    tension:  [60, 40, 60, 40, 60],    // anxiety triple pulse
    explode:  [120, 30, 120, 30, 250], // X — escalating explosion
    success:  [80, 60, 120],           // logo reveal — satisfying
    light:    [40],                     // tagline — subtle
  };

  const canVibrate = typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';

  const vibe = useCallback((pattern: number[], label: string) => {
    if (canVibrate) {
      navigator.vibrate(pattern);
    } else {
      haptic(label === 'slam' ? 'heavy' : label === 'explode' ? 'error' : 'medium' as any);
    }
  }, [canVibrate, haptic]);

  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    const t = (fn: () => void, at: number) => { timers.push(setTimeout(fn, at)); };

    //  Timeline — strong vibrations
    t(() => { setStep(0); triggerFlash('#22c55e', 250); triggerShake(500); vibe(VIBE.slam, 'slam'); }, 700);
    t(() => { setStep(1); triggerFlash('#22c55e', 200); vibe(VIBE.medium, 'medium'); }, 1600);
    t(() => { setStep(2); triggerFlash('#22c55e', 250); triggerShake(350); vibe(VIBE.slam, 'slam'); }, 2400);
    t(() => { setStep(3); triggerFlash('#a855f7', 300); vibe(VIBE.soft, 'soft'); }, 3200);
    t(() => { setStep(4); vibe(VIBE.tension, 'tension'); }, 4000);
    t(() => { setStep(5); triggerFlash('#dc2626', 450); triggerShake(600); vibe(VIBE.explode, 'explode'); }, 4800);
    t(() => { setStep(6); triggerFlash('#ffffff', 400); vibe(VIBE.success, 'success'); }, 6400);
    t(() => { setStep(7); vibe(VIBE.light, 'light'); }, 7600);
    t(() => { setStep(8); }, 8800);
    t(finish, 9800);

    return () => { timers.forEach(clearTimeout); };
  }, [finish, triggerFlash, triggerShake, vibe]);

  const isCardPhase = step >= 0 && step <= 5;
  const isLogoPhase = step >= 6;
  const isFading = step >= 8;

  const equation = useMemo(() => {
    if (step < 0) return '';
    const parts = ['Mo', 'O', 'V', 'I'].slice(0, Math.min(step + 1, 4));
    let eq = parts.join(' + ');
    if (step >= 5) eq += ' + X';
    if (step >= 6) eq += ' \u2192 MOVIX';
    return eq;
  }, [step]);

  return (
    <div
      className={`fixed inset-0 z-[99999] overflow-hidden transition-opacity duration-800
        ${isFading ? 'opacity-0' : 'opacity-100'}
        ${shaking ? 'intro-shake' : ''}`}
      style={{ background: '#010a01', height: '100dvh', touchAction: 'none', WebkitTapHighlightColor: 'transparent' }}
    >
      <style>{KEYFRAMES}</style>

      {/* ===== BACKGROUND LAYERS ===== */}
      {<>

      {/* Molecular dot grid */}
      <div className="absolute inset-0 opacity-30"
        style={{
          backgroundImage: 'radial-gradient(circle, rgba(34,197,94,0.12) 1px, transparent 1px)',
          backgroundSize: '28px 28px',
        }}
      />

      {/* Hexagonal molecular pattern overlay */}
      <svg className="absolute inset-0 w-full h-full opacity-[0.04]" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <pattern id="hex" width="56" height="100" patternUnits="userSpaceOnUse" patternTransform="scale(1.2)">
            <path d="M28 2L54 18V50L28 66L2 50V18Z" fill="none" stroke="#22c55e" strokeWidth="0.5"/>
            <path d="M28 34L54 50V82L28 98L2 82V50Z" fill="none" stroke="#22c55e" strokeWidth="0.5"/>
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#hex)"/>
      </svg>

      {/* CRT scanning line */}
      <div className="absolute left-0 right-0 h-[2px] pointer-events-none z-10 intro-scanline"
        style={{
          background: 'linear-gradient(90deg, transparent 5%, rgba(34,197,94,0.25) 50%, transparent 95%)',
          boxShadow: '0 0 20px 4px rgba(34,197,94,0.08)',
        }}
      />

      {/* Secondary slower scanline */}
      <div className="absolute left-0 right-0 h-[1px] pointer-events-none z-10 intro-scanline-slow"
        style={{
          background: 'linear-gradient(90deg, transparent 10%, rgba(34,197,94,0.12) 50%, transparent 90%)',
        }}
      />

      {/* Vignette */}
      <div className="absolute inset-0 pointer-events-none z-[1]"
        style={{ background: 'radial-gradient(ellipse at center, transparent 30%, rgba(0,0,0,0.8) 100%)' }}
      />

      {/* Ambient green light pulses */}
      {step >= 0 && (
        <>
          <div className="absolute top-1/3 left-1/4 w-48 h-48 sm:w-96 sm:h-96 pointer-events-none intro-ambient-1"
            style={{
              background: 'radial-gradient(circle, rgba(34,197,94,0.06) 0%, transparent 70%)',
              filter: 'blur(40px)',
            }}
          />
          <div className="absolute bottom-1/4 right-1/3 w-40 h-40 sm:w-80 sm:h-80 pointer-events-none intro-ambient-2"
            style={{
              background: 'radial-gradient(circle, rgba(34,197,94,0.04) 0%, transparent 70%)',
              filter: 'blur(50px)',
            }}
          />
        </>
      )}

      {/* Red ambient when X appears */}
      {step >= 5 && (
        <div className="absolute top-1/2 right-[20%] w-48 h-48 sm:w-96 sm:h-96 -translate-y-1/2 pointer-events-none intro-ambient-red"
          style={{
            background: 'radial-gradient(circle, rgba(220,38,38,0.08) 0%, transparent 60%)',
            filter: 'blur(60px)',
          }}
        />
      )}

      {/* ===== FLASH OVERLAY ===== */}
      {flash && (
        <div
          className="absolute inset-0 z-40 pointer-events-none intro-flash"
          style={{ backgroundColor: flash }}
        />
      )}

      {/* ===== CARD PHASE ===== */}
      {isCardPhase && (
        <div className="absolute inset-0 flex items-center justify-center z-20">
          <div className="flex items-end gap-1 sm:gap-3 md:gap-5 relative">

            {ELEMENTS.map((el, i) => (
              <div key={el.symbol} className="relative">
                {/* Particle explosion on appear */}
                {step >= i && (
                  <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-30">
                    {(allParticles[i as keyof typeof allParticles] || []).map((p, pi) => (
                      <div
                        key={pi}
                        className="absolute rounded-full intro-particle"
                        style={{
                          width: p.size,
                          height: p.size,
                          backgroundColor: i === 3 ? '#a855f7' : '#22c55e',
                          boxShadow: `0 0 ${p.size * 3}px ${i === 3 ? 'rgba(168,85,247,0.8)' : 'rgba(34,197,94,0.8)'}`,
                          '--px': `${Math.cos(p.angle) * p.dist}px`,
                          '--py': `${Math.sin(p.angle) * p.dist}px`,
                          animationDuration: `${p.dur}s`,
                          animationDelay: `${p.delay}s`,
                        } as React.CSSProperties}
                      />
                    ))}
                  </div>
                )}

                {/* Smoke/vapor rising from card */}
                {step >= i && (
                  <div className="absolute -top-1 sm:-top-2 left-1/2 -translate-x-1/2 w-12 sm:w-20 h-16 sm:h-24 pointer-events-none z-20">
                    {(isMobile ? [0, 1] : [0, 1, 2, 3]).map(si => (
                      <div
                        key={si}
                        className="absolute bottom-0 rounded-full blur-lg intro-smoke"
                        style={{
                          width: 14 + si * 8,
                          height: 14 + si * 8,
                          left: `${20 + si * 12}%`,
                          animationDelay: `${si * 0.12}s`,
                          backgroundColor: i === 3 ? 'rgba(168,85,247,0.15)' : 'rgba(34,197,94,0.12)',
                        }}
                      />
                    ))}
                  </div>
                )}

                {/* The periodic table card */}
                {step >= i && (
                  <div
                    className={`relative flex flex-col items-center justify-center select-none
                      rounded-sm backdrop-blur-sm
                      w-[50px] h-[66px] sm:w-[88px] sm:h-[112px] md:w-[105px] md:h-[132px]
                      ${step === 4 && step < 5 ? 'intro-tension' : ''}`}
                    style={{
                      animation: `${CARD_ANIMS[i]} 0.65s cubic-bezier(0.16, 1, 0.3, 1) forwards,
                                  cardGlow 2.5s ease-in-out 0.7s infinite`,
                      border: `1.5px solid ${i === 3 ? 'rgba(168,85,247,0.5)' : 'rgba(34,197,94,0.45)'}`,
                      background: `linear-gradient(170deg, ${i === 3 ? 'rgba(59,7,100,0.7)' : 'rgba(5,46,22,0.7)'} 0%, rgba(2,10,2,0.95) 100%)`,
                    }}
                  >
                    {/* Top category bar */}
                    <div className="absolute top-0 left-0 right-0 h-[2px]"
                      style={{ background: i === 3
                        ? 'linear-gradient(90deg, transparent, rgba(168,85,247,0.6), transparent)'
                        : 'linear-gradient(90deg, transparent, rgba(34,197,94,0.6), transparent)' }}
                    />

                    {/* Inner subtle glow */}
                    <div className="absolute inset-0 rounded-sm pointer-events-none"
                      style={{
                        background: `radial-gradient(ellipse at 50% 30%, ${i === 3 ? 'rgba(168,85,247,0.08)' : 'rgba(34,197,94,0.08)'} 0%, transparent 70%)`,
                      }}
                    />

                    {/* Atomic number */}
                    <span className={`absolute top-1 left-1.5 sm:top-1.5 sm:left-2 text-[7px] sm:text-[10px] md:text-xs font-mono font-bold
                      ${i === 3 ? 'text-purple-400/80' : 'text-green-400/80'}`}>
                      {el.number}
                    </span>

                    {/* Symbol */}
                    <span
                      className={`text-lg sm:text-3xl md:text-5xl font-bold leading-none mt-1 sm:mt-2
                        ${i === 3 ? 'text-purple-300' : 'text-green-300'}`}
                      style={{
                        textShadow: `0 0 20px ${i === 3 ? 'rgba(168,85,247,0.6)' : 'rgba(34,197,94,0.6)'},
                                     0 0 40px ${i === 3 ? 'rgba(168,85,247,0.2)' : 'rgba(34,197,94,0.2)'}`,
                        fontFamily: 'Georgia, "Palatino Linotype", "Book Antiqua", Palatino, serif',
                        letterSpacing: el.symbol.length > 1 ? '-0.02em' : '0',
                      }}
                    >
                      {el.symbol}
                    </span>

                    {/* Element name */}
                    <span className={`text-[5px] sm:text-[8px] md:text-[9px] mt-0.5 sm:mt-1.5 tracking-[0.1em] sm:tracking-[0.15em] uppercase font-mono
                      ${i === 3 ? 'text-purple-400/50' : 'text-green-400/50'}`}>
                      {el.name}
                    </span>

                    {/* Atomic mass */}
                    <span className={`hidden sm:inline text-[7px] font-mono mt-0.5
                      ${i === 3 ? 'text-purple-400/30' : 'text-green-400/30'}`}>
                      {el.mass}
                    </span>

                    {/* Corner brackets */}
                    {[
                      'top-0 left-0 border-t border-l',
                      'top-0 right-0 border-t border-r',
                      'bottom-0 left-0 border-b border-l',
                      'bottom-0 right-0 border-b border-r',
                    ].map(pos => (
                      <div key={pos}
                        className={`absolute w-1.5 h-1.5 sm:w-3 sm:h-3 ${pos} ${i === 3 ? 'border-purple-400/25' : 'border-green-400/25'}`}
                      />
                    ))}
                  </div>
                )}
              </div>
            ))}

            {/* ===== X ENTRANCE ===== */}
            {step >= 5 && (
              <div className="relative w-[50px] h-[66px] sm:w-[88px] sm:h-[112px] md:w-[105px] md:h-[132px]
                flex items-center justify-center">

                {/* Energy gathering point */}
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                  <div className="intro-energy-gather"
                    style={{
                      width: 6, height: 6,
                      borderRadius: '50%',
                      backgroundColor: '#dc2626',
                      boxShadow: '0 0 40px 15px rgba(220,38,38,0.6), 0 0 80px 30px rgba(220,38,38,0.2)',
                    }}
                  />
                </div>

                {/* Radiating ring */}
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                  <div className="intro-ring"
                    style={{
                      width: 4, height: 4,
                      borderRadius: '50%',
                      border: '1px solid rgba(220,38,38,0.6)',
                      boxShadow: '0 0 15px rgba(220,38,38,0.3)',
                    }}
                  />
                </div>

                {/* X SVG — 4 strokes radiating from center */}
                <svg viewBox="0 0 80 100" className="w-full h-full relative z-10" fill="none">
                  <defs>
                    <filter id="xglow">
                      <feGaussianBlur stdDeviation="2.5" result="blur"/>
                      <feComposite in="SourceGraphic" in2="blur" operator="over"/>
                    </filter>
                    <filter id="xglow-strong">
                      <feGaussianBlur stdDeviation="5" result="blur"/>
                      <feMerge>
                        <feMergeNode in="blur"/>
                        <feMergeNode in="blur"/>
                        <feMergeNode in="SourceGraphic"/>
                      </feMerge>
                    </filter>
                  </defs>
                  {/* Shadow / glow layer */}
                  <g filter="url(#xglow-strong)" opacity="0.5">
                    <line x1="40" y1="50" x2="16" y2="18" stroke="#dc2626" strokeWidth="7" strokeLinecap="round"
                      className="intro-x-stroke" style={{ animationDelay: '0.25s' }}/>
                    <line x1="40" y1="50" x2="64" y2="18" stroke="#dc2626" strokeWidth="7" strokeLinecap="round"
                      className="intro-x-stroke" style={{ animationDelay: '0.35s' }}/>
                    <line x1="40" y1="50" x2="16" y2="82" stroke="#dc2626" strokeWidth="7" strokeLinecap="round"
                      className="intro-x-stroke" style={{ animationDelay: '0.45s' }}/>
                    <line x1="40" y1="50" x2="64" y2="82" stroke="#dc2626" strokeWidth="7" strokeLinecap="round"
                      className="intro-x-stroke" style={{ animationDelay: '0.55s' }}/>
                  </g>
                  {/* Main crisp layer */}
                  <g filter="url(#xglow)">
                    <line x1="40" y1="50" x2="16" y2="18" stroke="#ef4444" strokeWidth="4.5" strokeLinecap="round"
                      className="intro-x-stroke" style={{ animationDelay: '0.25s' }}/>
                    <line x1="40" y1="50" x2="64" y2="18" stroke="#ef4444" strokeWidth="4.5" strokeLinecap="round"
                      className="intro-x-stroke" style={{ animationDelay: '0.35s' }}/>
                    <line x1="40" y1="50" x2="16" y2="82" stroke="#ef4444" strokeWidth="4.5" strokeLinecap="round"
                      className="intro-x-stroke" style={{ animationDelay: '0.45s' }}/>
                    <line x1="40" y1="50" x2="64" y2="82" stroke="#ef4444" strokeWidth="4.5" strokeLinecap="round"
                      className="intro-x-stroke" style={{ animationDelay: '0.55s' }}/>
                  </g>
                  {/* Bright center dot */}
                  <circle cx="40" cy="50" r="3" fill="#fff" opacity="0"
                    className="intro-center-dot"/>
                </svg>

                {/* Sparkles flying from X */}
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-20">
                  {SPARKLE_POSITIONS.map((sp, i) => (
                    <div key={i}
                      className="absolute w-1.5 h-1.5 bg-red-400 rounded-full intro-sparkle"
                      style={{
                        left: `${sp.x}%`,
                        top: `${sp.y}%`,
                        animationDelay: `${sp.delay}s`,
                        boxShadow: '0 0 6px 2px rgba(248,113,113,0.8)',
                      }}
                    />
                  ))}
                </div>

                {/* Red particles explosion */}
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-20">
                  {(allParticles[4] || []).map((p, pi) => (
                    <div key={pi}
                      className="absolute rounded-full intro-particle"
                      style={{
                        width: p.size,
                        height: p.size,
                        backgroundColor: '#ef4444',
                        boxShadow: `0 0 ${p.size * 3}px rgba(239,68,68,0.9)`,
                        '--px': `${Math.cos(p.angle) * p.dist}px`,
                        '--py': `${Math.sin(p.angle) * p.dist}px`,
                        animationDuration: `${p.dur}s`,
                        animationDelay: `${0.3 + p.delay}s`,
                      } as React.CSSProperties}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Chemical equation */}
          {step >= 0 && (
            <div className="absolute bottom-[10%] sm:bottom-[14%] left-0 right-0 text-center">
              <span className="text-green-500/35 text-[10px] sm:text-xs md:text-sm font-mono tracking-[0.2em] intro-equation">
                {equation}
              </span>
            </div>
          )}
        </div>
      )}

      {/* ===== LOGO PHASE ===== */}
      {isLogoPhase && (
        <div className="absolute inset-0 flex items-center justify-center z-20">
          <div className="flex flex-col items-center relative intro-logo-container">

            {/* Background energy burst */}
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="w-[250px] h-[250px] sm:w-[500px] sm:h-[500px] intro-logo-burst"
                style={{
                  background: 'radial-gradient(circle, rgba(220,38,38,0.15) 0%, rgba(34,197,94,0.05) 40%, transparent 70%)',
                  filter: 'blur(30px)',
                }}
              />
            </div>

            {/* Logo letters */}
            <h1 className="relative text-4xl sm:text-7xl md:text-[10rem] font-black tracking-[0.08em] sm:tracking-[0.15em] flex items-baseline z-10"
              style={{ fontFamily: 'Georgia, "Palatino Linotype", "Book Antiqua", Palatino, serif' }}>
              {['M', 'O', 'V', 'I'].map((letter, i) => (
                <span key={letter}
                  className="inline-block intro-logo-letter"
                  style={{
                    animationDelay: `${i * 0.08}s`,
                    color: '#22c55e',
                    textShadow: '0 0 30px rgba(34,197,94,0.5), 0 0 60px rgba(34,197,94,0.2)',
                  }}
                >
                  {letter}
                </span>
              ))}
              <span className="inline-block intro-logo-x ml-0.5 sm:ml-2"
                style={{
                  color: '#dc2626',
                  textShadow: '0 0 40px rgba(220,38,38,0.7), 0 0 80px rgba(220,38,38,0.3), 0 0 120px rgba(220,38,38,0.1)',
                }}
              >
                X
              </span>
            </h1>

            {/* Lens flare sweep */}
            <div className="absolute top-1/2 -translate-y-1/2 left-0 right-0 h-full overflow-hidden pointer-events-none z-20">
              <div className="intro-lens-flare"
                style={{
                  position: 'absolute',
                  top: '30%',
                  width: '80px',
                  height: '40%',
                  background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.5) 40%, rgba(255,255,255,0.8) 50%, rgba(255,255,255,0.5) 60%, transparent)',
                  filter: 'blur(8px)',
                  transform: 'skewX(-15deg)',
                }}
              />
            </div>

            {/* Expanding underline */}
            <div className="mt-4 sm:mt-6 h-[1.5px] intro-logo-line relative overflow-hidden"
              style={{
                background: 'linear-gradient(90deg, transparent, rgba(34,197,94,0.5) 30%, rgba(220,38,38,0.5) 70%, transparent)',
              }}
            />

            {/* Tagline */}
            {step >= 7 && (
              <p className="mt-5 sm:mt-8 text-white/40 text-[10px] sm:text-xs md:text-sm tracking-[0.4em] uppercase font-mono intro-tagline">
                {t('introAnimation.tagline')}
              </p>
            )}
          </div>
        </div>
      )}

      {/* ===== SKIP BUTTON (during animation) ===== */}
      <button
          onClick={() => { haptic('selection'); skipIntro(); }}
          className="absolute top-5 right-5 sm:top-6 sm:right-6 text-white/20 hover:text-white/60 text-[10px] sm:text-xs
                    px-3 py-1.5 sm:px-4 sm:py-2 transition-all duration-300 hover:bg-white/5 rounded
                    border border-white/[0.06] hover:border-white/15 z-[100000] font-mono tracking-widest uppercase"
        >
          {t('introAnimation.skip')}
        </button>

      </>}

    </div>
  );
};

/* ============================================
   KEYFRAMES — cinematic Breaking Bad intro
   ============================================ */
const KEYFRAMES = `
  /* --- CARD ENTRANCES --- */
  @keyframes slamIn {
    0% { opacity: 0; transform: translateX(-60px) rotate(-8deg) scale(0.6); filter: brightness(2.5) blur(3px); }
    50% { opacity: 1; transform: translateX(6px) rotate(1deg) scale(1.05); filter: brightness(1.5) blur(0); }
    75% { transform: translateX(-3px) rotate(-0.3deg) scale(0.97); filter: brightness(1.1); }
    100% { opacity: 1; transform: translateX(0) rotate(0) scale(1); filter: brightness(1); }
  }
  @media (min-width: 640px) {
    @keyframes slamIn {
      0% { opacity: 0; transform: translateX(-100px) rotate(-12deg) scale(0.6); filter: brightness(2.5) blur(4px); }
      50% { opacity: 1; transform: translateX(10px) rotate(1.5deg) scale(1.06); filter: brightness(1.5) blur(0); }
      75% { transform: translateX(-4px) rotate(-0.5deg) scale(0.97); filter: brightness(1.1); }
      100% { opacity: 1; transform: translateX(0) rotate(0) scale(1); filter: brightness(1); }
    }
  }

  @keyframes bubbleUp {
    0% { opacity: 0; transform: translateY(30px) scale(0.7); filter: blur(2px); }
    30% { opacity: 1; filter: blur(0); }
    60% { transform: translateY(-6px) scale(1.04); }
    80% { transform: translateY(2px) scale(0.98); }
    100% { opacity: 1; transform: translateY(0) scale(1); }
  }
  @media (min-width: 640px) {
    @keyframes bubbleUp {
      0% { opacity: 0; transform: translateY(50px) scale(0.7); filter: blur(3px); }
      30% { opacity: 1; filter: blur(0); }
      60% { transform: translateY(-10px) scale(1.04); }
      80% { transform: translateY(3px) scale(0.98); }
      100% { opacity: 1; transform: translateY(0) scale(1); }
    }
  }

  @keyframes dropIn {
    0% { opacity: 0; transform: translateY(-40px) scaleY(1.2) scaleX(0.9); filter: brightness(2) blur(2px); }
    45% { opacity: 1; transform: translateY(4px) scaleY(0.96) scaleX(1.02); filter: brightness(1.3) blur(0); }
    70% { transform: translateY(-2px) scaleY(1.01) scaleX(0.99); filter: brightness(1.1); }
    100% { opacity: 1; transform: translateY(0) scale(1); filter: brightness(1); }
  }
  @media (min-width: 640px) {
    @keyframes dropIn {
      0% { opacity: 0; transform: translateY(-70px) scaleY(1.3) scaleX(0.85); filter: brightness(2) blur(2px); }
      45% { opacity: 1; transform: translateY(6px) scaleY(0.95) scaleX(1.03); filter: brightness(1.3) blur(0); }
      70% { transform: translateY(-3px) scaleY(1.01) scaleX(0.99); filter: brightness(1.1); }
      100% { opacity: 1; transform: translateY(0) scale(1); filter: brightness(1); }
    }
  }

  @keyframes materialize {
    0% { opacity: 0; transform: scale(1.3); filter: blur(10px) brightness(2.5); }
    30% { opacity: 0.6; filter: blur(4px) brightness(2); }
    60% { opacity: 0.9; transform: scale(0.97); filter: blur(1px) brightness(1.3); }
    100% { opacity: 1; transform: scale(1); filter: blur(0) brightness(1); }
  }
  @media (min-width: 640px) {
    @keyframes materialize {
      0% { opacity: 0; transform: scale(1.4); filter: blur(15px) brightness(3); }
      30% { opacity: 0.6; filter: blur(6px) brightness(2); }
      60% { opacity: 0.9; transform: scale(0.97); filter: blur(2px) brightness(1.3); }
      100% { opacity: 1; transform: scale(1); filter: blur(0) brightness(1); }
    }
  }

  /* --- CARD GLOW --- */
  @keyframes cardGlow {
    0%, 100% { box-shadow: 0 0 15px rgba(34,197,94,0.15), inset 0 0 10px rgba(34,197,94,0.03); }
    50% { box-shadow: 0 0 30px rgba(34,197,94,0.3), inset 0 0 20px rgba(34,197,94,0.06), 0 0 60px rgba(34,197,94,0.08); }
  }

  /* --- TENSION (cards vibrate before X) --- */
  @keyframes tension {
    0%, 100% { transform: translateX(0) translateY(0); }
    10% { transform: translateX(-1.5px) translateY(0.5px); }
    20% { transform: translateX(1px) translateY(-1px); }
    30% { transform: translateX(-0.5px) translateY(1px); }
    40% { transform: translateX(1.5px) translateY(-0.5px); }
    50% { transform: translateX(-1px) translateY(-0.5px); }
    60% { transform: translateX(0.5px) translateY(1px); }
    70% { transform: translateX(-1px) translateY(-1px); }
    80% { transform: translateX(1px) translateY(0.5px); }
    90% { transform: translateX(-0.5px) translateY(-0.5px); }
  }
  .intro-tension { animation: tension 0.3s linear infinite !important; }

  /* --- PARTICLES --- */
  @keyframes particleBurst {
    0% { opacity: 1; transform: translate(0, 0) scale(1); }
    100% { opacity: 0; transform: translate(var(--px), var(--py)) scale(0); }
  }
  .intro-particle {
    opacity: 0;
    animation: particleBurst forwards;
    animation-fill-mode: forwards;
  }

  /* --- SMOKE --- */
  @keyframes smokeRise {
    0% { opacity: 0.4; transform: translateY(0) scaleX(1) scaleY(1); }
    50% { opacity: 0.2; transform: translateY(-20px) scaleX(1.5) scaleY(1.1); }
    100% { opacity: 0; transform: translateY(-40px) scaleX(2) scaleY(0.5); }
  }
  @media (min-width: 640px) {
    @keyframes smokeRise {
      0% { opacity: 0.5; transform: translateY(0) scaleX(1) scaleY(1); }
      50% { opacity: 0.3; transform: translateY(-30px) scaleX(1.8) scaleY(1.2); }
      100% { opacity: 0; transform: translateY(-70px) scaleX(3) scaleY(0.5); }
    }
  }
  .intro-smoke { animation: smokeRise 1.5s ease-out forwards; }

  /* --- SCREEN FLASH --- */
  @keyframes screenFlash {
    0% { opacity: 0; }
    8% { opacity: 0.35; }
    25% { opacity: 0.15; }
    100% { opacity: 0; }
  }
  .intro-flash { animation: screenFlash 0.35s ease-out forwards; }

  /* --- SCREEN SHAKE --- */
  @keyframes shake {
    0%, 100% { transform: translate(0, 0); }
    10% { transform: translate(-2px, 1px); }
    20% { transform: translate(2px, -1px); }
    30% { transform: translate(-1px, 1px); }
    40% { transform: translate(1px, -1px); }
    50% { transform: translate(-1px, 1px); }
    60% { transform: translate(1px, 0); }
    80% { transform: translate(-1px, 0); }
  }
  @media (min-width: 640px) {
    @keyframes shake {
      0%, 100% { transform: translate(0, 0) rotate(0); }
      10% { transform: translate(-4px, 2px) rotate(-0.3deg); }
      20% { transform: translate(3px, -3px) rotate(0.3deg); }
      30% { transform: translate(-3px, 1px) rotate(-0.2deg); }
      40% { transform: translate(2px, -2px) rotate(0.2deg); }
      50% { transform: translate(-2px, 3px) rotate(-0.1deg); }
      60% { transform: translate(3px, -1px) rotate(0.1deg); }
      70% { transform: translate(-1px, 2px); }
      80% { transform: translate(1px, -1px); }
      90% { transform: translate(-1px, 1px); }
    }
  }
  .intro-shake { animation: shake 0.5s ease-in-out; }

  /* --- CRT SCANLINES --- */
  @keyframes scanDown {
    0% { top: -5%; }
    100% { top: 105%; }
  }
  .intro-scanline { animation: scanDown 2.8s linear infinite; }
  .intro-scanline-slow { animation: scanDown 5s linear infinite; animation-delay: 1.5s; }

  /* --- AMBIENT LIGHTS --- */
  @keyframes ambientDrift1 {
    0%, 100% { transform: translate(0, 0) scale(1); opacity: 0.5; }
    33% { transform: translate(30px, -20px) scale(1.1); opacity: 0.7; }
    66% { transform: translate(-20px, 15px) scale(0.9); opacity: 0.4; }
  }
  @keyframes ambientDrift2 {
    0%, 100% { transform: translate(0, 0) scale(1); opacity: 0.4; }
    50% { transform: translate(-25px, -30px) scale(1.15); opacity: 0.6; }
  }
  .intro-ambient-1 { animation: ambientDrift1 8s ease-in-out infinite; }
  .intro-ambient-2 { animation: ambientDrift2 6s ease-in-out infinite; }
  .intro-ambient-red { animation: ambientDrift1 4s ease-in-out infinite; }

  /* --- X DRAWING --- */
  @keyframes drawStroke {
    0% { stroke-dashoffset: 200; }
    100% { stroke-dashoffset: 0; }
  }
  .intro-x-stroke {
    stroke-dasharray: 200;
    stroke-dashoffset: 200;
    animation: drawStroke 0.5s cubic-bezier(0.4, 0, 0.2, 1) forwards;
  }

  /* --- X ENERGY GATHER --- */
  @keyframes energyGather {
    0% { transform: scale(0); opacity: 0; }
    30% { opacity: 1; transform: scale(4); }
    60% { transform: scale(2); }
    100% { opacity: 0.6; transform: scale(1); }
  }
  .intro-energy-gather { animation: energyGather 0.6s ease-out forwards; }

  /* --- X RING EXPAND --- */
  @keyframes ringExpand {
    0% { transform: scale(0); opacity: 1; }
    100% { transform: scale(25); opacity: 0; }
  }
  .intro-ring { animation: ringExpand 1s ease-out 0.2s forwards; }

  /* --- X CENTER DOT --- */
  @keyframes centerDot {
    0% { opacity: 0; r: 0; }
    20% { opacity: 1; r: 5; }
    60% { opacity: 0.8; r: 3; }
    100% { opacity: 0; r: 0; }
  }
  .intro-center-dot { animation: centerDot 0.8s ease-out 0.2s forwards; }

  /* --- SPARKLES --- */
  @keyframes sparkle {
    0% { opacity: 0; transform: scale(0); }
    40% { opacity: 1; transform: scale(1.5); }
    100% { opacity: 0; transform: scale(0); }
  }
  .intro-sparkle { opacity: 0; animation: sparkle 0.5s ease-out forwards; }

  /* --- CHEMICAL EQUATION --- */
  @keyframes fadeInUp {
    0% { opacity: 0; transform: translateY(10px); }
    100% { opacity: 1; transform: translateY(0); }
  }
  .intro-equation { animation: fadeInUp 0.5s ease-out forwards; }

  /* --- LOGO PHASE --- */
  @keyframes logoContainer {
    0% { opacity: 0; transform: scale(2.5); filter: blur(30px) brightness(5); }
    30% { opacity: 1; filter: blur(8px) brightness(2.5); }
    60% { transform: scale(0.97); filter: blur(2px) brightness(1.3); }
    100% { opacity: 1; transform: scale(1); filter: blur(0) brightness(1); }
  }
  .intro-logo-container { animation: logoContainer 1.2s cubic-bezier(0.16, 1, 0.3, 1) forwards; }

  @keyframes logoBurst {
    0% { transform: scale(0); opacity: 1; }
    100% { transform: scale(1); opacity: 0.5; }
  }
  .intro-logo-burst { animation: logoBurst 1.5s ease-out forwards; }

  @keyframes letterReveal {
    0% { opacity: 0; transform: translateY(20px) scale(0.8); filter: blur(4px); }
    100% { opacity: 1; transform: translateY(0) scale(1); filter: blur(0); }
  }
  .intro-logo-letter {
    opacity: 0;
    animation: letterReveal 0.6s cubic-bezier(0.16, 1, 0.3, 1) forwards;
  }

  @keyframes xReveal {
    0% { opacity: 0; transform: scale(3) rotate(90deg); filter: blur(10px) brightness(4); }
    40% { opacity: 1; filter: blur(2px) brightness(2); }
    70% { transform: scale(0.95) rotate(-3deg); filter: brightness(1.2); }
    100% { opacity: 1; transform: scale(1) rotate(0); filter: blur(0) brightness(1); }
  }
  .intro-logo-x {
    opacity: 0;
    animation: xReveal 0.8s cubic-bezier(0.16, 1, 0.3, 1) 0.3s forwards;
  }

  @keyframes lensFlare {
    0% { left: -15%; opacity: 0; }
    10% { opacity: 0.8; }
    80% { opacity: 0.6; }
    100% { left: 115%; opacity: 0; }
  }
  .intro-lens-flare { opacity: 0; animation: lensFlare 1.4s ease-in-out 0.5s forwards; }

  @keyframes expandLine {
    0% { width: 0; opacity: 0; }
    100% { width: min(320px, 60vw); opacity: 1; }
  }
  .intro-logo-line { width: 0; animation: expandLine 0.8s ease-out 0.6s forwards; }

  @keyframes taglineIn {
    0% { opacity: 0; transform: translateY(8px); letter-spacing: 0.8em; }
    100% { opacity: 0.4; transform: translateY(0); letter-spacing: 0.4em; }
  }
  .intro-tagline { opacity: 0; animation: taglineIn 1s ease-out forwards; }

  /* --- TAP TO START SCREEN --- */
  @keyframes tapPulse {
    0%, 100% { transform: scale(1); opacity: 0.7; }
    50% { transform: scale(1.05); opacity: 1; }
  }
  .intro-tap-pulse { animation: tapPulse 2s ease-in-out infinite; }

  @keyframes ringPulseOut {
    0% { transform: scale(1); opacity: 0.4; }
    100% { transform: scale(2); opacity: 0; }
  }
  .intro-ring-pulse {
    animation: ringPulseOut 2.5s ease-out infinite;
  }
  .intro-ring-pulse-delayed {
    animation: ringPulseOut 2.5s ease-out 1s infinite;
  }

  @keyframes tapTextBlink {
    0%, 100% { opacity: 0.4; }
    50% { opacity: 0.8; }
  }
  .intro-tap-text { animation: tapTextBlink 2.5s ease-in-out infinite; }
`;

export default IntroAnimation;
