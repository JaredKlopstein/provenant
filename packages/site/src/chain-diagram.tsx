/**
 * Three receipts linked by prev_hash, the chain head they lead to, and the RFC
 * 3161 timestamp over it. Inline SVG with no external assets; colours come from
 * CSS (currentColor and the .chain-diagram rules in app/globals.css), and the
 * picture is named by its <title> and <desc>.
 */
const RECEIPTS = [0, 1, 2] as const;
const BOX = { w: 92, h: 64, y: 28, gap: 40 };
const x = (i: number) => 8 + i * (BOX.w + BOX.gap);
const HEAD_X = x(3);
const SEAL_CX = x(4) + 40;

export function ChainDiagram({ id = 'chain-diagram' }: { id?: string }) {
  const mid = BOX.y + BOX.h / 2;
  return (
    <svg
      className="chain-diagram"
      viewBox={`0 0 ${SEAL_CX + 52} 128`}
      role="img"
      aria-labelledby={`${id}-title ${id}-desc`}
      focusable="false"
    >
      <title id={`${id}-title`}>A hash chain anchored by a timestamp</title>
      <desc id={`${id}-desc`}>
        Three receipts, numbered 0 to 2. Each one stores the SHA-256 hash of the one before it as prev_hash, so
        they form one chain. The last receipt&apos;s hash is the chain head, and an RFC 3161 timestamp authority
        signs a statement over that head.
      </desc>
      <defs>
        <marker id={`${id}-arrow`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M0 0L10 5L0 10z" className="chain-diagram-ink" />
        </marker>
      </defs>
      {RECEIPTS.map((i) => (
        <g key={i}>
          <rect x={x(i)} y={BOX.y} width={BOX.w} height={BOX.h} rx="6" className="chain-diagram-box" />
          <text x={x(i) + BOX.w / 2} y={mid - 4} textAnchor="middle" className="chain-diagram-label">
            #{i}
          </text>
          <text x={x(i) + BOX.w / 2} y={mid + 16} textAnchor="middle" className="chain-diagram-small">
            receipt
          </text>
          <line
            x1={x(i) + BOX.w}
            y1={mid}
            x2={x(i + 1) - 4}
            y2={mid}
            className="chain-diagram-line"
            markerEnd={`url(#${id}-arrow)`}
          />
        </g>
      ))}
      <text x={x(1) - BOX.gap / 2} y={BOX.y - 10} textAnchor="middle" className="chain-diagram-small">
        prev_hash
      </text>
      <rect x={HEAD_X} y={BOX.y} width={BOX.w} height={BOX.h} rx="6" className="chain-diagram-head" />
      <text x={HEAD_X + BOX.w / 2} y={mid + 6} textAnchor="middle" className="chain-diagram-label">
        head
      </text>
      <line x1={HEAD_X + BOX.w} y1={mid} x2={SEAL_CX - 36} y2={mid} className="chain-diagram-line" markerEnd={`url(#${id}-arrow)`} />
      <circle cx={SEAL_CX} cy={mid} r="32" className="chain-diagram-seal" />
      <text x={SEAL_CX} y={mid + 6} textAnchor="middle" className="chain-diagram-label chain-diagram-seal-text">
        TSA
      </text>
      <text x={SEAL_CX} y={BOX.y + BOX.h + 30} textAnchor="middle" className="chain-diagram-small">
        RFC 3161
      </text>
    </svg>
  );
}
