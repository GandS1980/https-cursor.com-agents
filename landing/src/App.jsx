import { useState, useEffect, useRef } from "react";

/*
  PIXEL — RecruiterStack Landing Page Redesign

  DESIGN DIRECTION: "The Expiration Clock"
  The hero doesn't describe the product. It holds up a mirror.
  Jordan sees credentials counting down in real time and thinks:
  "I have this exact problem right now."

  SIGNATURE ELEMENT: Live credential expiration ticker in the hero.
  Real cert types. Real countdown timers. Ticking.

  PALETTE:
  - #050505   background (near-black)
  - #FAFAFA   headlines (clinical white)
  - #A1A1AA   body text (zinc-400)
  - #F59E0B   amber — urgency, warnings (NOT generic green)
  - #EF4444   red — critical expiration ONLY (earns its meaning)
  - #22C55E   green — confirmed/safe states only
  - #1C1C1E   card surfaces

  TYPOGRAPHY:
  - Instrument Serif — hero headline only, used with restraint
  - DM Mono — everything else (data, UI, nav, body)

  ANTI-PATTERN AVOIDANCE:
  - No acid-green-on-black generic SaaS look
  - No numbered 01/02/03 decorative markers
  - No "AI-powered" anywhere
  - No feature list in hero
  - Amber replaces green as the primary accent — unusual for SaaS, correct for urgency
*/

const FONTS = "https://fonts.googleapis.com/css2?family=DM+Mono:wght@300;400;500&family=Instrument+Serif:ital@0;1&display=swap";

// Live credential data — ticks in real time
const SEED_CREDENTIALS = [
  { name: "M. Rodriguez", cert: "BLS", daysLeft: 2, specialty: "Travel RN" },
  { name: "T. Washington", cert: "ACLS", daysLeft: 5, specialty: "CRNA" },
  { name: "K. Okafor", cert: "DEA License", daysLeft: 9, specialty: "Locum MD" },
  { name: "S. Patel", cert: "NPI Active", daysLeft: 14, specialty: "NP" },
  { name: "D. Chen", cert: "BLS", daysLeft: 18, specialty: "Allied Health" },
  { name: "R. Williams", cert: "PALS", daysLeft: 21, specialty: "Peds RN" },
  { name: "A. Martinez", cert: "CPI Cert", daysLeft: 28, specialty: "Psych RN" },
  { name: "J. Thompson", cert: "ACLS", daysLeft: 31, specialty: "ICU RN" },
];

function urgencyColor(days) {
  if (days <= 7) return "#EF4444";
  if (days <= 14) return "#F59E0B";
  return "#A1A1AA";
}

function urgencyLabel(days) {
  if (days <= 1) return "EXPIRES TOMORROW";
  if (days <= 7) return `${days}D — CRITICAL`;
  if (days <= 14) return `${days}D — WARNING`;
  return `${days} DAYS`;
}

// Animated counter that counts up from 0
function CountUp({ target, duration = 1200, suffix = "" }) {
  const [val, setVal] = useState(0);
  const ref = useRef(null);
  useEffect(() => {
    const obs = new IntersectionObserver(([e]) => {
      if (e.isIntersecting) {
        let start = null;
        const step = (ts) => {
          if (!start) start = ts;
          const p = Math.min((ts - start) / duration, 1);
          setVal(Math.floor(p * target));
          if (p < 1) requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
        obs.disconnect();
      }
    });
    if (ref.current) obs.observe(ref.current);
    return () => obs.disconnect();
  }, [target, duration]);
  return <span ref={ref}>{val}{suffix}</span>;
}

// Pulsing dot for live indicator
function LiveDot({ color = "#EF4444" }) {
  return (
    <span style={{ position: "relative", display: "inline-block", width: 8, height: 8 }}>
      <span style={{
        position: "absolute", inset: 0, borderRadius: "50%",
        background: color, opacity: 0.4,
        animation: "ping 1.4s cubic-bezier(0,0,0.2,1) infinite",
      }} />
      <span style={{
        position: "absolute", inset: 0, borderRadius: "50%",
        background: color,
      }} />
    </span>
  );
}

// Individual ticker row with real countdown
function TickerRow({ cred, index }) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const iv = setInterval(() => setSeconds(s => s + 1), 1000);
    return () => clearInterval(iv);
  }, []);

  const totalSeconds = cred.daysLeft * 86400 - seconds;
  const d = Math.floor(totalSeconds / 86400);
  const h = Math.floor((totalSeconds % 86400) / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const color = urgencyColor(cred.daysLeft);
  const isCritical = cred.daysLeft <= 7;

  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "1fr auto auto auto",
      gap: "16px",
      alignItems: "center",
      padding: "12px 16px",
      borderBottom: "1px solid rgba(255,255,255,0.04)",
      background: isCritical ? `rgba(239,68,68,0.04)` : "transparent",
      animation: index === 0 ? "fadeIn 0.6s ease forwards" : "none",
      opacity: 1,
    }}>
      {/* Candidate + cert */}
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {isCritical && <LiveDot color={color} />}
          <span style={{ fontSize: 11, color: "#FAFAFA", fontFamily: "'DM Mono', monospace" }}>
            {cred.name}
          </span>
          <span style={{
            fontSize: 9, color: color, border: `1px solid ${color}40`,
            padding: "1px 6px", letterSpacing: 1,
          }}>{cred.cert}</span>
        </div>
        <div style={{ fontSize: 9, color: "#52525B", marginTop: 2 }}>{cred.specialty}</div>
      </div>
      {/* Countdown */}
      <div style={{
        fontFamily: "'DM Mono', monospace",
        fontSize: 11, color: color,
        letterSpacing: "0.5px",
        textAlign: "right",
      }}>
        {d > 0 ? `${d}d ${String(h).padStart(2,"0")}h ${String(m).padStart(2,"0")}m` : `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`}
      </div>
      {/* Status badge */}
      <div style={{
        fontSize: 8, fontWeight: 700, letterSpacing: 1.5,
        color: color, opacity: 0.9,
        whiteSpace: "nowrap",
      }}>
        {urgencyLabel(cred.daysLeft)}
      </div>
    </div>
  );
}

// SMS proof screenshot component
function SMSProof() {
  return (
    <div style={{
      background: "#1C1C1E",
      borderRadius: 20,
      padding: "12px",
      width: 260,
      boxShadow: "0 32px 64px rgba(0,0,0,0.6)",
      border: "1px solid rgba(255,255,255,0.06)",
    }}>
      {/* Phone status bar */}
      <div style={{
        display: "flex", justifyContent: "space-between",
        padding: "4px 8px 8px", fontSize: 10, color: "#71717A",
        fontFamily: "'DM Mono', monospace",
      }}>
        <span>6:35</span>
        <span>●●● ▲ ■</span>
      </div>
      {/* Contact header */}
      <div style={{
        textAlign: "center", paddingBottom: 10,
        borderBottom: "1px solid rgba(255,255,255,0.06)",
      }}>
        <div style={{
          width: 36, height: 36, borderRadius: "50%",
          background: "#3F3F46", margin: "0 auto 6px",
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 14, color: "#71717A",
        }}>👤</div>
        <div style={{ fontSize: 11, color: "#FAFAFA", fontFamily: "'DM Mono', monospace" }}>
          +1 (214) 560-1095
        </div>
      </div>
      {/* Old received message */}
      <div style={{ padding: "12px 8px 4px" }}>
        <div style={{
          background: "#3F3F46",
          borderRadius: "14px 14px 14px 4px",
          padding: "8px 12px",
          maxWidth: "80%",
          fontSize: 11,
          color: "#FAFAFA",
          fontFamily: "'DM Mono', monospace",
          lineHeight: 1.5,
          marginBottom: 6,
        }}>
          Hello
        </div>
        <div style={{ fontSize: 8, color: "#52525B", marginBottom: 10, fontFamily: "'DM Mono', monospace" }}>
          Fri, May 29 at 7:37 AM
        </div>
        {/* The chase SMS */}
        <div style={{
          background: "#1D4ED8",
          borderRadius: "14px 14px 4px 14px",
          padding: "10px 12px",
          marginLeft: "auto",
          maxWidth: "95%",
          fontSize: 11,
          color: "#FAFAFA",
          fontFamily: "'DM Mono', monospace",
          lineHeight: 1.6,
        }}>
          Michelle — tomorrow your Credential expires. I need this resolved today or I'll have to pause your active submissions. Reply with your updated cert or call me directly. Reply STOP to opt out.
        </div>
        <div style={{ fontSize: 8, color: "#52525B", textAlign: "right", marginTop: 4, fontFamily: "'DM Mono', monospace" }}>
          Today 6:35 PM · Delivered
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [email, setEmail] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [showSticky, setShowSticky] = useState(false);
  const [heroVisible, setHeroVisible] = useState(false);
  const [activeTab, setActiveTab] = useState(0);

  useEffect(() => {
    const link = document.createElement("link");
    link.href = FONTS; link.rel = "stylesheet";
    document.head.appendChild(link);

    const style = document.createElement("style");
    style.textContent = `
      @keyframes ping {
        75%, 100% { transform: scale(2); opacity: 0; }
      }
      @keyframes fadeIn {
        from { opacity: 0; transform: translateY(8px); }
        to { opacity: 1; transform: translateY(0); }
      }
      @keyframes slideDown {
        from { opacity: 0; transform: translateY(-16px); }
        to { opacity: 1; transform: translateY(0); }
      }
      @keyframes tickerScroll {
        0% { transform: translateY(0); }
        100% { transform: translateY(-50%); }
      }
      * { box-sizing: border-box; }
      ::selection { background: rgba(245,158,11,0.3); }
      ::-webkit-scrollbar { width: 4px; }
      ::-webkit-scrollbar-track { background: #050505; }
      ::-webkit-scrollbar-thumb { background: #27272A; }
    `;
    document.head.appendChild(style);
    setTimeout(() => setHeroVisible(true), 80);

    const onScroll = () => {
      const pct = window.scrollY / (document.documentElement.scrollHeight - window.innerHeight) * 100;
      setShowSticky(pct > 45 && !submitted);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [submitted]);

  const handleSubmit = (e) => {
    e?.preventDefault?.();
    if (email.includes("@")) setSubmitted(true);
  };

  const products = [
    {
      name: "Credential Chaser",
      problem: "You're about to lose a placement you've worked on for 3 weeks. The BLS expired 11 days ago. Nobody caught it.",
      what: "Upload your candidates. Credential Chaser tracks every cert, license, and document — and sends automated SMS chase sequences when something's about to expire.",
      proof: "Candidates renew their own credentials. You get notified when they do.",
      color: "#F59E0B",
      price: "$49",
    },
    {
      name: "Outreach Writer",
      problem: "Your message sounds like every other recruiter's message. The CRNA you've been trying to reach deletes it in 2 seconds.",
      what: "Paste the job. Get 3 specialty-specific messages written for a CRNA, not a warehouse picker. Sent in under 2 minutes.",
      proof: "The AI knows CRNAs care about autonomy and schedule flexibility. It knows vascular surgeons care about case volume.",
      color: "#3B82F6",
      price: "$39",
    },
    {
      name: "Database Resurrector",
      problem: "You're paying for job boards to find new candidates when you already have 400 warm ones who've worked with you before.",
      what: "Search your old candidates in plain English. 'ICU RN, Texas, available in 30 days.' Get a re-engagement message drafted instantly.",
      proof: "A placed candidate is a warm candidate. They already cleared credentialing. They just stopped hearing from you.",
      color: "#8B5CF6",
      price: "$59",
    },
  ];

  return (
    <div style={{
      fontFamily: "'DM Mono', 'SF Mono', monospace",
      background: "#050505",
      color: "#A1A1AA",
      minHeight: "100vh",
      overflowX: "hidden",
    }}>
      {/* Ambient background */}
      <div style={{
        position: "fixed", inset: 0, zIndex: 0, pointerEvents: "none",
        background: `
          radial-gradient(ellipse 70% 40% at 50% 0%, rgba(245,158,11,0.05), transparent),
          radial-gradient(ellipse 50% 60% at 90% 50%, rgba(59,130,246,0.03), transparent)
        `,
      }} />

      {/* ── NAV ── */}
      <nav style={{
        position: "relative", zIndex: 20,
        maxWidth: 1200, margin: "0 auto",
        padding: "20px 40px",
        display: "flex", justifyContent: "space-between", alignItems: "center",
        borderBottom: "1px solid rgba(255,255,255,0.04)",
        animation: heroVisible ? "slideDown 0.5s ease forwards" : "none",
        opacity: heroVisible ? 1 : 0,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{
            width: 28, height: 28, background: "#F59E0B",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 12, fontWeight: 700, color: "#000",
          }}>R</div>
          <span style={{ fontSize: 13, fontWeight: 500, color: "#FAFAFA", letterSpacing: "-0.5px" }}>
            RecruiterStack
          </span>
          <span style={{
            fontSize: 8, color: "#F59E0B", padding: "2px 6px",
            border: "1px solid rgba(245,158,11,0.3)", letterSpacing: 1,
          }}>BETA</span>
        </div>
        <div style={{ display: "flex", gap: 28, alignItems: "center" }}>
          {["PRODUCTS", "PROOF", "PRICING"].map(l => (
            <a key={l} href={`#${l.toLowerCase()}`} style={{
              fontSize: 9, color: "#52525B", textDecoration: "none", letterSpacing: 2,
              transition: "color 0.2s",
            }}
              onMouseEnter={e => e.target.style.color = "#A1A1AA"}
              onMouseLeave={e => e.target.style.color = "#52525B"}
            >{l}</a>
          ))}
          <button
            onClick={() => document.getElementById("hero-email")?.focus()}
            style={{
              background: "#F59E0B", color: "#000", border: "none",
              padding: "8px 18px", fontSize: 9, fontWeight: 700,
              letterSpacing: 1.5, cursor: "pointer", fontFamily: "inherit",
            }}>
            GET EARLY ACCESS
          </button>
        </div>
      </nav>

      {/* ══════════════════════════════════════════
          HERO — The Accusation
      ══════════════════════════════════════════ */}
      <section style={{
        position: "relative", zIndex: 1,
        maxWidth: 1200, margin: "0 auto",
        padding: "80px 40px 60px",
        display: "grid",
        gridTemplateColumns: "1fr 420px",
        gap: 60,
        alignItems: "center",
        opacity: heroVisible ? 1 : 0,
        transform: heroVisible ? "none" : "translateY(24px)",
        transition: "opacity 0.7s ease, transform 0.7s ease",
      }}>
        {/* LEFT: Accusation */}
        <div>
          <div style={{
            display: "inline-flex", alignItems: "center", gap: 8,
            fontSize: 9, color: "#F59E0B", letterSpacing: 2,
            border: "1px solid rgba(245,158,11,0.2)",
            padding: "4px 12px", marginBottom: 28,
          }}>
            <LiveDot color="#F59E0B" />
            BUILT BY A WORKING HEALTHCARE RECRUITER
          </div>

          <h1 style={{
            fontFamily: "'Instrument Serif', Georgia, serif",
            fontSize: "clamp(38px, 5vw, 62px)",
            fontWeight: 400,
            color: "#FAFAFA",
            lineHeight: 1.1,
            letterSpacing: "-2px",
            margin: "0 0 8px 0",
          }}>
            You're losing placements
          </h1>
          <h1 style={{
            fontFamily: "'Instrument Serif', Georgia, serif",
            fontSize: "clamp(38px, 5vw, 62px)",
            fontWeight: 400,
            fontStyle: "italic",
            color: "#F59E0B",
            lineHeight: 1.1,
            letterSpacing: "-2px",
            margin: "0 0 28px 0",
          }}>
            you already earned.
          </h1>

          <p style={{
            fontSize: 13, lineHeight: 1.8, color: "#71717A",
            maxWidth: 480, margin: "0 0 36px 0",
          }}>
            Credential Chaser shows you which candidates are submission-ready before the req drops — and automatically chases the ones who aren't.
          </p>

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <input
              id="hero-email"
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="work@youragency.com"
              onKeyDown={e => e.key === "Enter" && handleSubmit()}
              style={{
                background: "#0F0F0F", border: "1px solid #27272A",
                padding: "13px 18px", color: "#FAFAFA", fontSize: 12,
                fontFamily: "inherit", outline: "none", width: 260,
                transition: "border-color 0.2s",
              }}
              onFocus={e => e.target.style.borderColor = "#F59E0B"}
              onBlur={e => e.target.style.borderColor = "#27272A"}
            />
            <button
              onClick={handleSubmit}
              style={{
                background: submitted ? "#166534" : "#F59E0B",
                color: "#000", border: "none", padding: "13px 24px",
                fontSize: 10, fontWeight: 700, letterSpacing: 1.5,
                fontFamily: "inherit", cursor: "pointer", whiteSpace: "nowrap",
                transition: "opacity 0.2s",
              }}
              onMouseEnter={e => e.target.style.opacity = "0.85"}
              onMouseLeave={e => e.target.style.opacity = "1"}
            >
              {submitted ? "✓ YOU'RE IN" : "GET EARLY ACCESS →"}
            </button>
          </div>
          {submitted && (
            <p style={{ fontSize: 10, color: "#22C55E", marginTop: 10 }}>
              ✓ We'll be in touch within 24 hours.
            </p>
          )}
          <p style={{ fontSize: 9, color: "#3F3F46", marginTop: 12 }}>
            14-day free trial · No credit card required · Cancel anytime
          </p>
        </div>

        {/* RIGHT: Live Credential Ticker — THE SIGNATURE ELEMENT */}
        <div style={{ position: "relative" }}>
          <div style={{
            background: "#0A0A0A",
            border: "1px solid rgba(255,255,255,0.06)",
            borderRadius: 2,
            overflow: "hidden",
          }}>
            {/* Ticker header */}
            <div style={{
              padding: "12px 16px",
              borderBottom: "1px solid rgba(255,255,255,0.06)",
              display: "flex", justifyContent: "space-between", alignItems: "center",
              background: "#0F0F0F",
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <LiveDot color="#EF4444" />
                <span style={{ fontSize: 9, color: "#FAFAFA", letterSpacing: 2, fontWeight: 500 }}>
                  CREDENTIAL EXPIRATION MONITOR
                </span>
              </div>
              <span style={{ fontSize: 8, color: "#52525B" }}>LIVE · 8 TRACKED</span>
            </div>
            {/* Column headers */}
            <div style={{
              display: "grid",
              gridTemplateColumns: "1fr auto auto",
              gap: 16,
              padding: "6px 16px",
              borderBottom: "1px solid rgba(255,255,255,0.04)",
              background: "#080808",
            }}>
              {["CANDIDATE / CERT", "EXPIRES IN", "STATUS"].map(h => (
                <span key={h} style={{ fontSize: 7, color: "#3F3F46", letterSpacing: 1.5 }}>{h}</span>
              ))}
            </div>
            {/* Live rows */}
            {SEED_CREDENTIALS.map((cred, i) => (
              <TickerRow key={i} cred={cred} index={i} />
            ))}
            {/* Footer action */}
            <div style={{
              padding: "10px 16px",
              background: "#0F0F0F",
              borderTop: "1px solid rgba(255,255,255,0.04)",
              display: "flex", justifyContent: "space-between", alignItems: "center",
            }}>
              <span style={{ fontSize: 9, color: "#52525B" }}>2 critical · 3 warning · 3 clear</span>
              <span style={{
                fontSize: 8, color: "#F59E0B", letterSpacing: 1,
                cursor: "pointer", borderBottom: "1px solid rgba(245,158,11,0.3)",
              }}>
                CHASE ALL CRITICAL →
              </span>
            </div>
          </div>
          {/* Glow beneath */}
          <div style={{
            position: "absolute", bottom: -20, left: "10%", right: "10%",
            height: 40, background: "rgba(239,68,68,0.15)",
            filter: "blur(20px)", pointerEvents: "none",
          }} />
        </div>
      </section>

      {/* ── PROOF BAR ── */}
      <div style={{
        position: "relative", zIndex: 1,
        borderTop: "1px solid rgba(255,255,255,0.04)",
        borderBottom: "1px solid rgba(255,255,255,0.04)",
        background: "#080808",
      }}>
        <div style={{
          maxWidth: 1200, margin: "0 auto",
          padding: "24px 40px",
          display: "flex", justifyContent: "space-around", alignItems: "center",
          flexWrap: "wrap", gap: 24,
        }}>
          {[
            { n: 45, s: "min", label: "saved every morning on manual cert checks" },
            { n: 3, s: "x", label: "faster time-to-submit for ready candidates" },
            { n: 0, s: "$", label: "sourcing cost to re-engage a prior placed candidate", prefix: true },
          ].map(({ n, s, label, prefix }, i) => (
            <div key={i} style={{ textAlign: "center" }}>
              <div style={{
                fontFamily: "'Instrument Serif', serif",
                fontSize: 40, color: "#FAFAFA",
                letterSpacing: -2, lineHeight: 1,
              }}>
                {prefix && <span style={{ fontSize: 24 }}>{s}</span>}
                <CountUp target={n} />
                {!prefix && <span style={{ fontSize: 22, color: "#F59E0B" }}>{s}</span>}
              </div>
              <div style={{ fontSize: 9, color: "#52525B", maxWidth: 160, marginTop: 6, lineHeight: 1.5 }}>
                {label}
              </div>
            </div>
          ))}
          <div style={{ textAlign: "center" }}>
            <div style={{
              fontFamily: "'Instrument Serif', serif",
              fontSize: 40, color: "#FAFAFA",
              letterSpacing: -2, lineHeight: 1,
            }}>
              <CountUp target={100} suffix="%" />
            </div>
            <div style={{ fontSize: 9, color: "#52525B", maxWidth: 160, marginTop: 6, lineHeight: 1.5 }}>
              built by a recruiter who uses it daily
            </div>
          </div>
        </div>
      </div>

      {/* ══════════════════════════════════════════
          THE SMS PROOF SECTION
      ══════════════════════════════════════════ */}
      <section id="proof" style={{
        position: "relative", zIndex: 1,
        maxWidth: 1200, margin: "0 auto",
        padding: "100px 40px",
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gap: 80,
        alignItems: "center",
      }}>
        <div>
          <div style={{ fontSize: 9, color: "#F59E0B", letterSpacing: 2, marginBottom: 20 }}>
            THE NUDGE
          </div>
          <h2 style={{
            fontFamily: "'Instrument Serif', serif",
            fontSize: "clamp(28px, 3.5vw, 44px)",
            color: "#FAFAFA", lineHeight: 1.15, letterSpacing: -1.5,
            margin: "0 0 20px 0", fontWeight: 400,
          }}>
            This SMS lands on your candidate's phone automatically.
          </h2>
          <p style={{ fontSize: 13, color: "#71717A", lineHeight: 1.8, marginBottom: 32 }}>
            You don't write it. You don't send it. You don't follow up.
            When a credential is about to expire, Credential Chaser fires a chase sequence
            and gives the candidate a direct path to upload their renewal.
          </p>
          <p style={{ fontSize: 13, color: "#71717A", lineHeight: 1.8, marginBottom: 32 }}>
            You find out when the credential is resolved — not when the client flags it.
          </p>
          <div style={{
            display: "flex", gap: 12, flexWrap: "wrap",
          }}>
            {["BLS / ACLS / PALS", "State Nursing License", "DEA License", "NPI Active", "Malpractice Insurance", "BCLS", "TB Test", "COVID Immunization"].map(tag => (
              <span key={tag} style={{
                fontSize: 9, color: "#52525B", padding: "4px 10px",
                border: "1px solid #27272A", letterSpacing: 0.5,
              }}>{tag}</span>
            ))}
          </div>
        </div>
        <div style={{ display: "flex", justifyContent: "center", position: "relative" }}>
          <SMSProof />
          {/* Ambient glow */}
          <div style={{
            position: "absolute", inset: -20, zIndex: -1,
            background: "radial-gradient(ellipse at center, rgba(245,158,11,0.08), transparent 70%)",
            pointerEvents: "none",
          }} />
        </div>
      </section>

      {/* ══════════════════════════════════════════
          PAIN SECTION — The Mirror
      ══════════════════════════════════════════ */}
      <section style={{
        position: "relative", zIndex: 1,
        background: "#080808",
        borderTop: "1px solid rgba(255,255,255,0.04)",
        borderBottom: "1px solid rgba(255,255,255,0.04)",
      }}>
        <div style={{ maxWidth: 1200, margin: "0 auto", padding: "80px 40px" }}>
          <div style={{ textAlign: "center", marginBottom: 52 }}>
            <div style={{ fontSize: 9, color: "#EF4444", letterSpacing: 2, marginBottom: 16 }}>
              WHAT THIS WEEK LOOKS LIKE WITHOUT IT
            </div>
            <h2 style={{
              fontFamily: "'Instrument Serif', serif",
              fontSize: "clamp(26px, 3vw, 38px)",
              color: "#FAFAFA", fontWeight: 400,
              letterSpacing: -1, margin: 0,
            }}>
              Jordan's Monday morning.
            </h2>
          </div>
          <div style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
            gap: 1,
            background: "rgba(255,255,255,0.04)",
          }}>
            {[
              { label: "THE EXPIRED CERT", copy: "Ready to submit. BLS expired 11 days ago. Nobody caught it. You find out from the client.", color: "#EF4444" },
              { label: "THE GHOST CANDIDATE", copy: "3 weeks of nurturing. They vanish. $15K in margin gone. You had no system to catch the drift.", color: "#F59E0B" },
              { label: "THE BLANK MESSAGE", copy: "20 candidates to reach. Every message sounds like every other recruiter. The delete rate is 90%.", color: "#F59E0B" },
              { label: "THE LOST LEAD", copy: "Perfect CRNA req drops. You know you talked to someone 8 months ago. You can't find them.", color: "#A1A1AA" },
              { label: "THE SPREADSHEET", copy: "NCQA requires monthly credential monitoring. Your sheet hasn't been touched in 3 weeks.", color: "#EF4444" },
              { label: "THE NUMBER", copy: "8 days left. 60% of quota. Pipeline thin. Manager watching. You don't know who's ready to submit.", color: "#F59E0B" },
            ].map(({ label, copy, color }, i) => (
              <div key={i} style={{
                background: "#050505",
                padding: "28px 24px",
              }}>
                <div style={{
                  fontSize: 8, color, letterSpacing: 2,
                  marginBottom: 12, fontWeight: 600,
                }}>
                  {label}
                </div>
                <p style={{ fontSize: 12, color: "#71717A", lineHeight: 1.7, margin: 0 }}>
                  {copy}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ══════════════════════════════════════════
          PRODUCTS — tabbed
      ══════════════════════════════════════════ */}
      <section id="products" style={{
        position: "relative", zIndex: 1,
        maxWidth: 1200, margin: "0 auto",
        padding: "100px 40px",
      }}>
        <div style={{ marginBottom: 52 }}>
          <div style={{ fontSize: 9, color: "#F59E0B", letterSpacing: 2, marginBottom: 16 }}>
            THE STACK
          </div>
          <h2 style={{
            fontFamily: "'Instrument Serif', serif",
            fontSize: "clamp(26px, 3vw, 38px)",
            color: "#FAFAFA", fontWeight: 400,
            letterSpacing: -1, margin: 0,
          }}>
            Three tools. One problem.
          </h2>
        </div>

        {/* Tab buttons */}
        <div style={{ display: "flex", gap: 2, marginBottom: 1 }}>
          {products.map((p, i) => (
            <button
              key={i}
              onClick={() => setActiveTab(i)}
              style={{
                background: activeTab === i ? "#0F0F0F" : "#080808",
                border: `1px solid ${activeTab === i ? p.color + "40" : "rgba(255,255,255,0.04)"}`,
                borderBottom: activeTab === i ? `1px solid #0F0F0F` : "1px solid rgba(255,255,255,0.04)",
                padding: "10px 20px",
                fontSize: 10, color: activeTab === i ? "#FAFAFA" : "#52525B",
                cursor: "pointer", fontFamily: "inherit", letterSpacing: 1,
                transition: "all 0.2s",
                position: "relative", bottom: -1,
              }}
            >
              {p.name}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div style={{
          background: "#0F0F0F",
          border: `1px solid ${products[activeTab].color}30`,
          padding: "40px",
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 48,
          alignItems: "start",
        }}>
          <div>
            <div style={{
              fontSize: 9, color: products[activeTab].color,
              letterSpacing: 2, marginBottom: 16,
            }}>THE PROBLEM IT SOLVES</div>
            <p style={{ fontSize: 14, color: "#A1A1AA", lineHeight: 1.8, margin: "0 0 28px 0" }}>
              {products[activeTab].problem}
            </p>
            <div style={{
              fontSize: 9, color: "#52525B",
              letterSpacing: 2, marginBottom: 16,
            }}>HOW IT WORKS</div>
            <p style={{ fontSize: 13, color: "#71717A", lineHeight: 1.8, margin: "0 0 28px 0" }}>
              {products[activeTab].what}
            </p>
            <p style={{ fontSize: 12, color: "#52525B", lineHeight: 1.7, margin: 0, fontStyle: "italic" }}>
              {products[activeTab].proof}
            </p>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={{
              background: "#080808",
              border: `1px solid rgba(255,255,255,0.04)`,
              padding: "24px",
            }}>
              <div style={{ fontSize: 9, color: "#52525B", letterSpacing: 2, marginBottom: 8 }}>
                STARTS AT
              </div>
              <div style={{
                fontFamily: "'Instrument Serif', serif",
                fontSize: 52, color: "#FAFAFA",
                letterSpacing: -2, lineHeight: 1,
              }}>
                {products[activeTab].price}
                <span style={{ fontSize: 16, color: "#52525B" }}>/mo</span>
              </div>
              <div style={{ fontSize: 10, color: "#52525B", marginTop: 8 }}>
                14-day free trial included
              </div>
            </div>
            <button
              onClick={() => document.getElementById("hero-email")?.focus()}
              style={{
                background: products[activeTab].color,
                color: "#000", border: "none",
                padding: "14px", fontSize: 10,
                fontWeight: 700, letterSpacing: 1.5,
                cursor: "pointer", fontFamily: "inherit",
                transition: "opacity 0.2s",
              }}
              onMouseEnter={e => e.target.style.opacity = "0.85"}
              onMouseLeave={e => e.target.style.opacity = "1"}
            >
              START FREE TRIAL →
            </button>
          </div>
        </div>
      </section>

      {/* ══════════════════════════════════════════
          PRICING
      ══════════════════════════════════════════ */}
      <section id="pricing" style={{
        position: "relative", zIndex: 1,
        background: "#080808",
        borderTop: "1px solid rgba(255,255,255,0.04)",
      }}>
        <div style={{ maxWidth: 1200, margin: "0 auto", padding: "100px 40px" }}>
          <div style={{ textAlign: "center", marginBottom: 52 }}>
            <div style={{ fontSize: 9, color: "#F59E0B", letterSpacing: 2, marginBottom: 16 }}>
              PRICING
            </div>
            <h2 style={{
              fontFamily: "'Instrument Serif', serif",
              fontSize: "clamp(26px, 3vw, 38px)",
              color: "#FAFAFA", fontWeight: 400,
              letterSpacing: -1, margin: "0 0 12px 0",
            }}>
              One placement pays for a year.
            </h2>
            <p style={{ fontSize: 12, color: "#52525B", margin: 0 }}>
              Average healthcare placement fee: $8,000–$12,000.
              RecruiterStack: $49–$119/month.
            </p>
          </div>
          <div style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, 1fr)",
            gap: 2,
            background: "rgba(255,255,255,0.04)",
          }}>
            {[
              {
                name: "Credential Chaser",
                price: "$49",
                color: "#F59E0B",
                features: ["Unlimited candidates", "Automated SMS chase sequences", "30/60/90-day expiration alerts", "Candidate self-service portal", "CSV import", "Ready Now dashboard"],
                popular: false,
              },
              {
                name: "Full Stack",
                price: "$99",
                color: "#F59E0B",
                features: ["Everything in Credential Chaser", "Outreach Writer (unlimited)", "Database Resurrector", "Priority support", "All 3 products bundled"],
                popular: true,
              },
              {
                name: "Agency",
                price: "$199",
                color: "#F59E0B",
                features: ["Everything in Full Stack", "Up to 5 recruiter seats", "Shared candidate database", "Team performance view", "Custom specialty templates", "Dedicated onboarding call"],
                popular: false,
              },
            ].map((plan, i) => (
              <div key={i} style={{
                background: "#050505",
                padding: "32px 28px",
                position: "relative",
                borderTop: plan.popular ? `2px solid ${plan.color}` : "2px solid transparent",
              }}>
                {plan.popular && (
                  <div style={{
                    position: "absolute", top: -1, left: "50%",
                    transform: "translateX(-50%)",
                    background: plan.color, color: "#000",
                    fontSize: 7, fontWeight: 700, letterSpacing: 2,
                    padding: "3px 10px",
                  }}>MOST POPULAR</div>
                )}
                <div style={{ fontSize: 10, color: "#71717A", marginBottom: 12, marginTop: plan.popular ? 12 : 0 }}>
                  {plan.name}
                </div>
                <div style={{ marginBottom: 24 }}>
                  <span style={{
                    fontFamily: "'Instrument Serif', serif",
                    fontSize: 48, color: "#FAFAFA", letterSpacing: -2,
                  }}>{plan.price}</span>
                  <span style={{ fontSize: 11, color: "#52525B" }}>/mo</span>
                </div>
                {plan.features.map((f, fi) => (
                  <div key={fi} style={{
                    fontSize: 10, color: "#71717A",
                    padding: "7px 0",
                    borderBottom: fi < plan.features.length - 1 ? "1px solid rgba(255,255,255,0.03)" : "none",
                    display: "flex", gap: 10, alignItems: "flex-start",
                  }}>
                    <span style={{ color: plan.color, fontSize: 9, marginTop: 1 }}>✓</span>
                    {f}
                  </div>
                ))}
                <button
                  onClick={handleSubmit}
                  style={{
                    width: "100%", marginTop: 24,
                    background: plan.popular ? plan.color : "transparent",
                    color: plan.popular ? "#000" : plan.color,
                    border: `1px solid ${plan.color}`,
                    padding: 11, fontSize: 9, fontWeight: 700,
                    letterSpacing: 1.5, fontFamily: "inherit", cursor: "pointer",
                    transition: "all 0.2s",
                  }}
                  onMouseEnter={e => { e.target.style.background = plan.color; e.target.style.color = "#000"; }}
                  onMouseLeave={e => {
                    e.target.style.background = plan.popular ? plan.color : "transparent";
                    e.target.style.color = plan.popular ? "#000" : plan.color;
                  }}
                >
                  START FREE TRIAL
                </button>
              </div>
            ))}
          </div>
          <div style={{ textAlign: "center", fontSize: 9, color: "#3F3F46", marginTop: 20 }}>
            14-day free trial on all plans · No credit card required · Cancel anytime
          </div>
        </div>
      </section>

      {/* ══════════════════════════════════════════
          FINAL CTA
      ══════════════════════════════════════════ */}
      <section style={{
        position: "relative", zIndex: 1,
        maxWidth: 1200, margin: "0 auto",
        padding: "100px 40px",
        textAlign: "center",
      }}>
        <h2 style={{
          fontFamily: "'Instrument Serif', serif",
          fontSize: "clamp(32px, 4vw, 52px)",
          color: "#FAFAFA", fontWeight: 400,
          letterSpacing: -2, margin: "0 0 8px 0",
        }}>
          Your next placement is
        </h2>
        <h2 style={{
          fontFamily: "'Instrument Serif', serif",
          fontSize: "clamp(32px, 4vw, 52px)",
          color: "#F59E0B", fontStyle: "italic", fontWeight: 400,
          letterSpacing: -2, margin: "0 0 32px 0",
        }}>
          already in your database.
        </h2>
        <p style={{ fontSize: 13, color: "#52525B", maxWidth: 440, margin: "0 auto 36px" }}>
          Upload your candidate list. In 2 minutes, you'll see who's expiring,
          who to re-engage, and exactly what to say.
        </p>
        <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
          <input
            type="email" value={email}
            onChange={e => setEmail(e.target.value)}
            placeholder="work@youragency.com"
            onKeyDown={e => e.key === "Enter" && handleSubmit()}
            style={{
              background: "#0F0F0F", border: "1px solid #27272A",
              padding: "14px 20px", color: "#FAFAFA", fontSize: 12,
              fontFamily: "inherit", outline: "none", width: 280,
            }}
            onFocus={e => e.target.style.borderColor = "#F59E0B"}
            onBlur={e => e.target.style.borderColor = "#27272A"}
          />
          <button
            onClick={handleSubmit}
            style={{
              background: submitted ? "#166534" : "#F59E0B",
              color: "#000", border: "none", padding: "14px 28px",
              fontSize: 10, fontWeight: 700, letterSpacing: 1.5,
              fontFamily: "inherit", cursor: "pointer",
            }}
          >
            {submitted ? "✓ YOU'RE IN" : "GET EARLY ACCESS →"}
          </button>
        </div>
      </section>

      {/* ── FOOTER ── */}
      <footer style={{
        position: "relative", zIndex: 1,
        maxWidth: 1200, margin: "0 auto",
        padding: "24px 40px 40px",
        borderTop: "1px solid rgba(255,255,255,0.04)",
        display: "flex", justifyContent: "space-between", alignItems: "center",
        flexWrap: "wrap", gap: 12,
      }}>
        <div style={{ fontSize: 9, color: "#27272A" }}>
          © 2026 RecruiterStack · Built for healthcare recruiters, by a healthcare recruiter.
        </div>
        <div style={{ display: "flex", gap: 20 }}>
          {["Privacy", "Terms", "getrecruiterstack.com"].map(l => (
            <a key={l} href="#" style={{ fontSize: 9, color: "#3F3F46", textDecoration: "none" }}>{l}</a>
          ))}
        </div>
      </footer>

      {/* ── STICKY CTA ── */}
      <div style={{
        position: "fixed",
        bottom: showSticky ? 0 : -80,
        left: 0, right: 0, zIndex: 50,
        background: "rgba(5,5,5,0.94)",
        backdropFilter: "blur(20px)",
        borderTop: "1px solid rgba(245,158,11,0.15)",
        padding: "12px 40px",
        display: "flex", justifyContent: "center",
        alignItems: "center", gap: 16,
        transition: "bottom 0.4s cubic-bezier(0.16,1,0.3,1)",
      }}>
        <div style={{ fontSize: 11, color: "#A1A1AA" }}>
          <span style={{ fontFamily: "'Instrument Serif', serif", fontSize: 13, color: "#FAFAFA" }}>
            One placement pays for the year.
          </span>
          {" "}$99/mo for all 3 tools.
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <input
            type="email" value={email}
            onChange={e => setEmail(e.target.value)}
            placeholder="work@agency.com"
            style={{
              background: "#111", border: "1px solid #27272A",
              padding: "8px 14px", color: "#FAFAFA", fontSize: 11,
              fontFamily: "inherit", outline: "none", width: 200,
            }}
          />
          <button onClick={handleSubmit} style={{
            background: submitted ? "#166534" : "#F59E0B",
            color: "#000", border: "none", padding: "8px 18px",
            fontSize: 9, fontWeight: 700, letterSpacing: 1.5,
            fontFamily: "inherit", cursor: "pointer",
          }}>
            {submitted ? "✓ IN" : "EARLY ACCESS →"}
          </button>
        </div>
        {!submitted && (
          <button onClick={() => setShowSticky(false)} style={{
            background: "none", border: "none", color: "#3F3F46",
            cursor: "pointer", fontSize: 16, fontFamily: "inherit",
          }}>✕</button>
        )}
      </div>
    </div>
  );
}
