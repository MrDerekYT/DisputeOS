export function HeroArt({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 520 420" className={className} role="img" aria-label="Credit score rising with a shield">
      <defs>
        <linearGradient id="g1" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#6366f1" /><stop offset="1" stopColor="#a855f7" /></linearGradient>
        <linearGradient id="g2" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#22d3ee" stopOpacity=".9" /><stop offset="1" stopColor="#6366f1" stopOpacity=".1" /></linearGradient>
        <filter id="blur"><feGaussianBlur stdDeviation="22" /></filter>
      </defs>
      <circle cx="400" cy="90" r="90" fill="#a855f7" opacity=".35" filter="url(#blur)" />
      <circle cx="110" cy="330" r="90" fill="#6366f1" opacity=".3" filter="url(#blur)" />
      <g className="floaty">
        <rect x="40" y="60" width="440" height="290" rx="28" fill="#fff" opacity=".92" />
        <rect x="40" y="60" width="440" height="52" rx="28" fill="url(#g1)" />
        <rect x="40" y="90" width="440" height="22" fill="url(#g1)" />
        <circle cx="68" cy="86" r="6" fill="#fff" opacity=".8" /><circle cx="90" cy="86" r="6" fill="#fff" opacity=".5" /><circle cx="112" cy="86" r="6" fill="#fff" opacity=".3" />
        <path d="M70 300 C130 290 150 250 200 250 S270 270 320 200 S400 140 450 120 L450 320 L70 320 Z" fill="url(#g2)" />
        <path d="M70 300 C130 290 150 250 200 250 S270 270 320 200 S400 140 450 120" fill="none" stroke="url(#g1)" strokeWidth="5" strokeLinecap="round" />
        <circle cx="450" cy="120" r="9" fill="#fff" stroke="#7c3aed" strokeWidth="5" />
        <text x="72" y="160" fontSize="14" fill="#64748b" fontFamily="system-ui">Score trend</text>
        <text x="72" y="195" fontSize="38" fontWeight="800" fill="#0f172a" fontFamily="system-ui">+64</text>
        <rect x="340" y="140" width="110" height="30" rx="15" fill="#dcfce7" />
        <text x="357" y="160" fontSize="13" fontWeight="700" fill="#15803d" fontFamily="system-ui">3 items removed</text>
      </g>
      <g transform="translate(360 235)" className="floaty" style={{ animationDelay: "-2s" }}>
        <path d="M60 0 L120 22 V80 C120 125 90 150 60 164 C30 150 0 125 0 80 V22 Z" fill="url(#g1)" />
        <path d="M60 14 L108 31 V80 C108 116 84 136 60 148 C36 136 12 116 12 80 V31 Z" fill="#fff" opacity=".14" />
        <path d="M34 82 L54 102 L90 62" fill="none" stroke="#fff" strokeWidth="11" strokeLinecap="round" strokeLinejoin="round" />
      </g>
    </svg>
  );
}

export function ScoreChart({ points }: { points: { label: string; value: number }[] }) {
  const w = 560, h = 190, pad = 24;
  const min = Math.min(...points.map((p) => p.value)) - 20;
  const max = Math.max(...points.map((p) => p.value)) + 20;
  const x = (i: number) => pad + (i * (w - pad * 2)) / (points.length - 1);
  const y = (v: number) => h - pad - ((v - min) / (max - min)) * (h - pad * 2);
  const line = points.map((p, i) => `${i ? "L" : "M"}${x(i)} ${y(p.value)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full" role="img" aria-label="Score history">
      <defs>
        <linearGradient id="area" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#6366f1" stopOpacity=".28" /><stop offset="1" stopColor="#6366f1" stopOpacity="0" /></linearGradient>
        <linearGradient id="stroke" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#6366f1" /><stop offset="1" stopColor="#a855f7" /></linearGradient>
      </defs>
      {[0, 1, 2, 3].map((i) => <line key={i} x1={pad} x2={w - pad} y1={pad + (i * (h - pad * 2)) / 3} y2={pad + (i * (h - pad * 2)) / 3} stroke="#e2e8f0" strokeDasharray="4 6" />)}
      <path d={`${line} L${x(points.length - 1)} ${h - pad} L${x(0)} ${h - pad} Z`} fill="url(#area)" />
      <path d={line} fill="none" stroke="url(#stroke)" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
      {points.map((p, i) => (
        <g key={p.label}>
          <circle cx={x(i)} cy={y(p.value)} r="5" fill="#fff" stroke="#7c3aed" strokeWidth="3" />
          <text x={x(i)} y={h - 4} textAnchor="middle" fontSize="11" fill="#94a3b8">{p.label}</text>
        </g>
      ))}
    </svg>
  );
}

export function Ring({ value, label }: { value: number; label: string }) {
  const r = 44, c = 2 * Math.PI * r;
  return (
    <svg viewBox="0 0 110 110" className="h-28 w-28" role="img" aria-label={`${label} ${value}%`}>
      <defs><linearGradient id="ring" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#6366f1" /><stop offset="1" stopColor="#d946ef" /></linearGradient></defs>
      <circle cx="55" cy="55" r={r} fill="none" stroke="#e2e8f0" strokeWidth="10" />
      <circle cx="55" cy="55" r={r} fill="none" stroke="url(#ring)" strokeWidth="10" strokeLinecap="round"
        strokeDasharray={c} strokeDashoffset={c * (1 - value / 100)} transform="rotate(-90 55 55)" />
      <text x="55" y="61" textAnchor="middle" fontSize="22" fontWeight="800" fill="#0f172a">{value}%</text>
    </svg>
  );
}
