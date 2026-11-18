import { useEffect, useId, useRef, useState } from 'react'

export const NUTRITION_COLORS = {
  kcal: 'var(--acc)',
  protein: '#4f8cff',
  carbs: '#f59e0b',
  fat: '#f43f5e',
  fiber: '#10b981',
  water: '#06b6d4',
  sugar: '#a855f7',
  saturatedFat: '#ef4444',
  sodium: '#64748b',
}

const MACRO_KEYS = ['protein', 'carbs', 'fat']
const MACRO_KCAL_PER_G = { protein: 4, carbs: 4, fat: 9 }
const DEFAULT_MACRO_LABELS = {
  protein: 'Protéines',
  carbs: 'Glucides',
  fat: 'Lipides',
}

const MEAL_SHADES = {
  breakfast: '#f59e0b',
  lunch: '#4f8cff',
  dinner: '#8b5cf6',
  snack: '#10b981',
}
const MEAL_FALLBACK_SHADES = ['#4f8cff', '#f59e0b', '#8b5cf6', '#10b981', '#06b6d4', '#f43f5e']

const MODE_LABELS = {
  cut: 'Sèche',
  bulk: 'Prise de masse',
  maintenance: 'Maintien',
}

const CALIBRATION_ZONES = [
  { key: 'too-fast', label: 'Trop rapide', color: '#f59e0b', x: 53 },
  { key: 'well-calibrated', label: 'Zone idéale', color: '#10b981', x: 160 },
  { key: 'too-slow', label: 'Trop lent', color: '#4f8cff', x: 267 },
]

function toNum(v) {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function fmtInt(n) {
  const rounded = Math.round(n)
  return String(rounded === 0 ? 0 : rounded)
}

function fmtVal(n, maxDecimals = 1) {
  const factor = Math.pow(10, maxDecimals)
  const rounded = Math.round(n * factor) / factor
  return String(rounded === 0 ? 0 : rounded)
}

const chartRootStyle = {
  color: 'var(--label, #ffffff)',
  fontVariantNumeric: 'tabular-nums',
}

/**
 * Circular SVG radial calorie gauge with over-target warning coloring and centered summary.
 */
export function CalorieRing({
  consumed = 0,
  target = null,
  remaining = null,
  size = 156,
  strokeWidth = 14,
  subtitle = null,
}) {
  const safeConsumed = Math.max(0, toNum(consumed) ?? 0)
  const rawTarget = toNum(target)
  const hasTarget = rawTarget != null && rawTarget > 0
  const explicitRemaining = toNum(remaining)
  const effectiveRemaining = explicitRemaining != null
    ? explicitRemaining
    : hasTarget
      ? rawTarget - safeConsumed
      : null

  const center = size / 2
  const radius = Math.max(1, (size - strokeWidth) / 2)
  const circumference = 2 * Math.PI * radius
  const ratio = hasTarget ? Math.max(0, safeConsumed / rawTarget) : 0
  const clampedRatio = Math.min(1, ratio)
  const dashOffset = circumference * (1 - clampedRatio)

  const isOver = effectiveRemaining != null && effectiveRemaining < 0
  const overRatio = hasTarget && isOver ? Math.abs(effectiveRemaining) / rawTarget : 0
  const arcColor = isOver
    ? overRatio > 0.1
      ? '#ef4444'
      : '#f59e0b'
    : NUTRITION_COLORS.kcal

  const primaryText = hasTarget
    ? effectiveRemaining >= 0
      ? fmtInt(effectiveRemaining)
      : `+${fmtInt(Math.abs(effectiveRemaining))}`
    : fmtInt(safeConsumed)

  const secondaryText = subtitle != null
    ? subtitle
    : hasTarget
      ? `${fmtInt(safeConsumed)} / ${fmtInt(rawTarget)} kcal`
      : 'kcal'

  const statusCaption = hasTarget
    ? effectiveRemaining >= 0
      ? 'kcal restantes'
      : 'kcal dépassées'
    : null

  const ariaLabel = hasTarget
    ? effectiveRemaining >= 0
      ? `${fmtInt(safeConsumed)} sur ${fmtInt(rawTarget)} kcal, ${fmtInt(effectiveRemaining)} kcal restantes`
      : `${fmtInt(safeConsumed)} sur ${fmtInt(rawTarget)} kcal, +${fmtInt(Math.abs(effectiveRemaining))} kcal au-dessus de l’objectif`
    : `${fmtInt(safeConsumed)} kcal consommées`

  return (
    <div
      role="img"
      aria-label={ariaLabel}
      style={{
        ...chartRootStyle,
        position: 'relative',
        width: size,
        height: size,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
      }}
    >
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        aria-hidden="true"
        style={{ display: 'block' }}
      >
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke="var(--surface-3, rgba(128,128,128,0.22))"
          strokeWidth={strokeWidth}
        />
        {hasTarget && clampedRatio > 0 && (
          <circle
            cx={center}
            cy={center}
            r={radius}
            fill="none"
            stroke={arcColor}
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={dashOffset}
            transform={`rotate(-90 ${center} ${center})`}
            style={{ transition: 'stroke-dashoffset 220ms cubic-bezier(.32,.72,0,1), stroke 180ms ease' }}
          />
        )}
      </svg>
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          inset: strokeWidth + 4,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          textAlign: 'center',
          pointerEvents: 'none',
          lineHeight: 1.15,
        }}
      >
        <span
          style={{
            fontSize: Math.max(20, Math.round(size * 0.19)),
            fontWeight: 600,
            letterSpacing: '-0.025em',
            color: isOver ? arcColor : 'var(--label, #ffffff)',
          }}
        >
          {primaryText}
        </span>
        {statusCaption && (
          <span
            style={{
              fontSize: 11,
              color: 'var(--label-2, rgba(235,235,245,0.6))',
              marginTop: 2,
            }}
          >
            {statusCaption}
          </span>
        )}
        <span
          style={{
            fontSize: 11,
            color: 'var(--label-2, rgba(235,235,245,0.6))',
            marginTop: statusCaption ? 3 : 2,
            maxWidth: '100%',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {secondaryText}
        </span>
      </div>
    </div>
  )
}

/**
 * Interactive SVG donut showing macro energy share (4/4/9 kcal/g) with selectable slices
 * and compact legend with optional target percentages.
 */
export function MacroDonut({
  kcalFromMacros,
  grams = { protein: 0, carbs: 0, fat: 0 },
  targetPercents = null,
  labels = {},
}) {
  const [selectedKey, setSelectedKey] = useState(null)
  const pointerDownRef = useRef(false)

  const items = MACRO_KEYS.map(key => {
    const g = Math.max(0, toNum(grams?.[key]) ?? 0)
    const explicitKcal = kcalFromMacros ? toNum(kcalFromMacros[key]) : null
    const kcal = Math.max(0, explicitKcal != null ? explicitKcal : g * MACRO_KCAL_PER_G[key])
    return {
      key,
      label: labels?.[key] ?? DEFAULT_MACRO_LABELS[key],
      color: NUTRITION_COLORS[key],
      g,
      kcal,
      targetPct: toNum(targetPercents?.[key]),
    }
  })

  const totalKcal = items.reduce((sum, item) => sum + item.kcal, 0)
  const isEmpty = totalKcal <= 0

  const enriched = items.map(item => ({
    ...item,
    pct: isEmpty ? 0 : Math.round((item.kcal / totalKcal) * 100),
    exactPct: isEmpty ? 0 : (item.kcal / totalKcal) * 100,
  }))

  const activeItem = enriched.find(item => item.key === selectedKey) ?? null
  const nonZero = enriched.filter(item => item.kcal > 0)

  const size = 152
  const center = size / 2
  const radius = 54
  const baseStroke = 18
  const circumference = 2 * Math.PI * radius
  const gapPx = nonZero.length > 1 ? 3 : 0

  let cumulativeFraction = 0
  const slices = nonZero.map(item => {
    const fraction = item.kcal / totalKcal
    const rawLen = fraction * circumference
    const visibleLen = Math.max(2, rawLen - gapPx)
    const offset = -cumulativeFraction * circumference
    cumulativeFraction += fraction
    return { ...item, visibleLen, offset }
  })

  const toggleKey = key => {
    setSelectedKey(prev => (prev === key ? null : key))
  }

  return (
    <div
      style={{
        ...chartRootStyle,
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 16,
      }}
    >
      <div
        style={{
          position: 'relative',
          width: size,
          height: size,
          flexShrink: 0,
        }}
      >
        <svg
          width={size}
          height={size}
          viewBox={`0 0 ${size} ${size}`}
          role="img"
          aria-label={
            isEmpty
              ? 'Répartition des macros : aucune donnée'
              : `Répartition des macros sur ${fmtInt(totalKcal)} kcal`
          }
          style={{ display: 'block' }}
        >
          <circle
            cx={center}
            cy={center}
            r={radius}
            fill="none"
            stroke="var(--surface-3, rgba(128,128,128,0.22))"
            strokeWidth={baseStroke}
          />
          {!isEmpty && (
            <g transform={`rotate(-90 ${center} ${center})`}>
              {slices.map(slice => {
                const isSelected = selectedKey === slice.key
                const dimmed = selectedKey != null && !isSelected
                return (
                  <circle
                    key={slice.key}
                    data-slice={slice.key}
                    role="button"
                    tabIndex={0}
                    aria-pressed={isSelected}
                    aria-label={`${slice.label} : ${slice.pct}%, ${fmtInt(slice.kcal)} kcal, ${fmtVal(slice.g)} g`}
                    cx={center}
                    cy={center}
                    r={radius}
                    fill="none"
                    stroke={slice.color}
                    strokeWidth={isSelected ? baseStroke + 4 : baseStroke}
                    strokeDasharray={`${slice.visibleLen} ${circumference}`}
                    strokeDashoffset={slice.offset}
                    opacity={dimmed ? 0.35 : 1}
                    style={{
                      cursor: 'pointer',
                      outline: 'none',
                      transition: 'stroke-width 160ms ease, opacity 160ms ease',
                    }}
                    onMouseDown={() => {
                      pointerDownRef.current = true
                      setTimeout(() => { pointerDownRef.current = false }, 0)
                    }}
                    onTouchStart={() => {
                      pointerDownRef.current = true
                      setTimeout(() => { pointerDownRef.current = false }, 0)
                    }}
                    onFocus={() => {
                      if (!pointerDownRef.current) setSelectedKey(slice.key)
                    }}
                    onClick={() => {
                      pointerDownRef.current = false
                      toggleKey(slice.key)
                    }}
                    onKeyDown={e => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        toggleKey(slice.key)
                      }
                    }}
                  />
                )
              })}
            </g>
          )}
        </svg>

        <div
          data-donut-center="true"
          style={{
            position: 'absolute',
            inset: 26,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            textAlign: 'center',
            pointerEvents: 'none',
            lineHeight: 1.2,
          }}
        >
          {isEmpty ? (
            <>
              <span style={{ fontSize: 18, fontWeight: 600 }}>0 kcal</span>
              <span style={{ fontSize: 11, color: 'var(--label-2, rgba(235,235,245,0.6))', marginTop: 2 }}>
                Aucune donnée
              </span>
            </>
          ) : activeItem ? (
            <>
              <span style={{ fontSize: 11, fontWeight: 500, color: activeItem.color }}>
                {activeItem.label}
              </span>
              <span style={{ fontSize: 22, fontWeight: 600, letterSpacing: '-0.02em' }}>
                {activeItem.pct}%
              </span>
              <span style={{ fontSize: 11, color: 'var(--label-2, rgba(235,235,245,0.6))' }}>
                {fmtInt(activeItem.kcal)} kcal · {fmtVal(activeItem.g)} g
              </span>
            </>
          ) : (
            <>
              <span style={{ fontSize: 21, fontWeight: 600, letterSpacing: '-0.02em' }}>
                {fmtInt(totalKcal)}
              </span>
              <span style={{ fontSize: 11, color: 'var(--label-2, rgba(235,235,245,0.6))', marginTop: 2 }}>
                kcal macros
              </span>
            </>
          )}
        </div>
      </div>

      <div
        style={{
          flex: '1 1 160px',
          minWidth: 0,
          display: 'grid',
          gap: 6,
        }}
      >
        {enriched.map(item => {
          const isSelected = selectedKey === item.key
          return (
            <button
              key={item.key}
              type="button"
              data-legend={item.key}
              aria-pressed={isSelected}
              disabled={isEmpty}
              onClick={() => toggleKey(item.key)}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 8,
                width: '100%',
                padding: '6px 8px',
                borderRadius: 8,
                border: `1px solid ${isSelected ? item.color : 'transparent'}`,
                background: isSelected ? 'var(--surface-2, rgba(128,128,128,0.16))' : 'transparent',
                color: 'inherit',
                font: 'inherit',
                fontSize: 13,
                textAlign: 'left',
                cursor: isEmpty ? 'default' : 'pointer',
              }}
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
                <span
                  aria-hidden="true"
                  style={{
                    width: 9,
                    height: 9,
                    borderRadius: '50%',
                    background: item.color,
                    flexShrink: 0,
                  }}
                />
                <span style={{ fontWeight: isSelected ? 600 : 500 }}>{item.label}</span>
              </span>
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'baseline',
                  gap: 6,
                  color: 'var(--label-2, rgba(235,235,245,0.6))',
                  fontSize: 12,
                  whiteSpace: 'nowrap',
                }}
              >
                <strong style={{ color: 'var(--label, #ffffff)', fontWeight: 600 }}>
                  {item.pct}%
                </strong>
                <span>({fmtVal(item.g)} g)</span>
                {item.targetPct != null && (
                  <span style={{ fontSize: 11, color: 'var(--label-3, rgba(235,235,245,0.4))' }}>
                    cible {fmtInt(item.targetPct)}%
                  </span>
                )}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

/**
 * Horizontal rounded stacked bar proportional to kcal share per meal with compact legend.
 */
export function MealStackedBar({ meals = [] }) {
  const clipId = useId()
  const normalized = (Array.isArray(meals) ? meals : []).map((m, idx) => ({
    key: m.key ?? String(idx),
    label: m.label ?? m.key ?? `Repas ${idx + 1}`,
    kcal: Math.max(0, toNum(m.kcal) ?? 0),
    protein: Math.max(0, toNum(m.protein) ?? 0),
    color: MEAL_SHADES[m.key] ?? MEAL_FALLBACK_SHADES[idx % MEAL_FALLBACK_SHADES.length],
  }))

  const totalKcal = normalized.reduce((sum, m) => sum + m.kcal, 0)
  const isEmpty = totalKcal <= 0

  const W = 320
  const H = 14
  const activeMeals = normalized.filter(m => m.kcal > 0)
  const gap = activeMeals.length > 1 ? 2 : 0
  const usableW = W - gap * Math.max(0, activeMeals.length - 1)

  let cursorX = 0
  const segments = activeMeals.map((m, i) => {
    const segW = i === activeMeals.length - 1
      ? Math.max(0, W - cursorX)
      : Math.max(2, (m.kcal / totalKcal) * usableW)
    const x = cursorX
    cursorX += segW + gap
    return { ...m, x, width: segW }
  })

  return (
    <div style={{ ...chartRootStyle, display: 'grid', gap: 10 }}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height={H}
        preserveAspectRatio="none"
        role="img"
        aria-label={
          isEmpty
            ? 'Répartition calorique par repas : aucun apport'
            : `Répartition calorique sur ${fmtInt(totalKcal)} kcal`
        }
        style={{ display: 'block', borderRadius: H / 2, overflow: 'hidden' }}
      >
        <defs>
          <clipPath id={clipId}>
            <rect x="0" y="0" width={W} height={H} rx={H / 2} ry={H / 2} />
          </clipPath>
        </defs>
        <g clipPath={`url(#${clipId})`}>
          <rect
            x="0"
            y="0"
            width={W}
            height={H}
            fill="var(--surface-3, rgba(128,128,128,0.22))"
          />
          {!isEmpty && segments.map(seg => (
            <rect
              key={seg.key}
              data-meal-segment={seg.key}
              x={seg.x}
              y="0"
              width={seg.width}
              height={H}
              fill={seg.color}
            />
          ))}
        </g>
      </svg>

      {normalized.length === 0 ? (
        <p style={{ margin: 0, fontSize: 12, color: 'var(--label-2, rgba(235,235,245,0.6))' }}>
          Aucun repas enregistré
        </p>
      ) : (
        <>
          {isEmpty && (
            <p style={{ margin: 0, fontSize: 12, color: 'var(--label-2, rgba(235,235,245,0.6))' }}>
              0 kcal enregistrées aujourd’hui
            </p>
          )}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
              gap: '8px 12px',
            }}
          >
            {normalized.map(m => {
              const pct = isEmpty ? 0 : Math.round((m.kcal / totalKcal) * 100)
              return (
                <div
                  key={m.key}
                  data-meal-legend={m.key}
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 7,
                    minWidth: 0,
                  }}
                >
                  <span
                    aria-hidden="true"
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      background: m.color,
                      marginTop: 4,
                      flexShrink: 0,
                    }}
                  />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {m.label}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--label-2, rgba(235,235,245,0.6))' }}>
                      {pct}% · {fmtInt(m.kcal)} kcal · {fmtVal(m.protein)} g prot.
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}

/**
 * Responsive SVG bar chart (7 / 30 / 90 days) with unlogged slots, constant or stepped
 * training/rest target line, training-day markers, and selectable day tooltip.
 */
export function DailyTargetBars({
  days = [],
  metric = 'kcal',
  unit = 'kcal',
  color = 'var(--acc)',
  onSelectDay = null,
}) {
  const [selectedIdx, setSelectedIdx] = useState(null)
  const list = Array.isArray(days) ? days : []

  useEffect(() => {
    setSelectedIdx(null)
  }, [days, metric])

  if (list.length === 0) {
    return (
      <div
        style={{
          ...chartRootStyle,
          padding: '20px 12px',
          textAlign: 'center',
          fontSize: 13,
          color: 'var(--label-2, rgba(235,235,245,0.6))',
        }}
      >
        Aucune donnée sur la période
      </div>
    )
  }

  const W = 360
  const H = 150
  const P = { l: 34, r: 10, t: 14, b: 28 }
  const plotW = W - P.l - P.r
  const plotH = H - P.t - P.b
  const yBase = H - P.b

  const parsed = list.map((day, idx) => ({
    idx,
    d: day.d,
    label: day.label ?? day.d,
    value: day.value == null ? null : toNum(day.value),
    target: day.target == null ? null : toNum(day.target),
    isTrainingDay: Boolean(day.isTrainingDay),
    hasTrainingFlag: day.isTrainingDay !== undefined,
  }))

  const numericValues = []
  for (const item of parsed) {
    if (item.value != null) numericValues.push(Math.max(0, item.value))
    if (item.target != null) numericValues.push(Math.max(0, item.target))
  }
  const rawMax = numericValues.length > 0 ? Math.max(...numericValues, 1) : 100
  const yMax = rawMax * 1.12
  const Y = v => yBase - (Math.max(0, v) / yMax) * plotH

  const gridValues = [0, Math.round(rawMax / 2), Math.round(rawMax)]
  const slotW = plotW / parsed.length
  const barW = parsed.length <= 10
    ? Math.min(26, slotW * 0.56)
    : parsed.length <= 35
      ? Math.max(4, slotW * 0.65)
      : Math.max(1.8, slotW * 0.72)
  const rx = Math.min(4, barW / 2)
  const labelEvery = parsed.length <= 10 ? 1 : parsed.length <= 35 ? 5 : 15

  const nonNullTargets = parsed.map(p => p.target).filter(v => v != null && v >= 0)
  const hasAnyTarget = nonNullTargets.length > 0
  const allTargetsEqual = hasAnyTarget
    && nonNullTargets.every(v => v === nonNullTargets[0])
    && parsed.every(p => p.target === nonNullTargets[0])

  const steppedRuns = []
  if (hasAnyTarget && !allTargetsEqual) {
    let currentPts = []
    for (const item of parsed) {
      if (item.target != null && item.target >= 0) {
        const x0 = P.l + item.idx * slotW
        const x1 = P.l + (item.idx + 1) * slotW
        const y = Y(item.target)
        currentPts.push(`${x0.toFixed(1)},${y.toFixed(1)}`, `${x1.toFixed(1)},${y.toFixed(1)}`)
      } else if (currentPts.length > 0) {
        steppedRuns.push(currentPts.join(' '))
        currentPts = []
      }
    }
    if (currentPts.length > 0) steppedRuns.push(currentPts.join(' '))
  }

  const selectedDay = selectedIdx != null ? parsed[selectedIdx] ?? null : null

  const handleSelect = item => {
    setSelectedIdx(prev => (prev === item.idx ? null : item.idx))
    if (onSelectDay) onSelectDay(item.d)
  }

  return (
    <div style={{ ...chartRootStyle, display: 'grid', gap: 8 }}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        role="img"
        aria-label={`Historique ${metric} sur ${parsed.length} jours`}
        style={{ display: 'block', width: '100%', height: 'auto' }}
      >
        {gridValues.map((gv, i) => {
          const y = Y(gv)
          return (
            <g key={`grid-${i}`}>
              <line
                x1={P.l}
                y1={y}
                x2={W - P.r}
                y2={y}
                stroke="var(--sep-op, rgba(84,84,88,0.34))"
                strokeWidth="1"
                strokeDasharray="2 4"
              />
              <text
                x={P.l - 5}
                y={y + 3}
                textAnchor="end"
                fontSize="9"
                fill="var(--label-2, rgba(235,235,245,0.6))"
              >
                {fmtInt(gv)}
              </text>
            </g>
          )
        })}

        {parsed.map(item => {
          const cx = P.l + (item.idx + 0.5) * slotW
          const barX = cx - barW / 2
          const isSelected = selectedIdx === item.idx
          const dimmed = selectedIdx != null && !isSelected

          return (
            <g key={item.d ?? item.idx}>
              {item.value != null ? (
                (() => {
                  const safeVal = Math.max(0, item.value)
                  const barH = safeVal === 0 ? 2 : Math.max(2, yBase - Y(safeVal))
                  const barY = yBase - barH
                  return (
                    <rect
                      data-bar={item.d}
                      x={barX}
                      y={barY}
                      width={barW}
                      height={barH}
                      rx={rx}
                      fill={color}
                      opacity={dimmed ? 0.42 : 1}
                      stroke={isSelected ? 'var(--label, #ffffff)' : 'none'}
                      strokeWidth={isSelected ? 1.2 : 0}
                    />
                  )
                })()
              ) : (
                <line
                  data-unlogged={item.d}
                  x1={barX + 0.5}
                  y1={yBase - 1}
                  x2={barX + barW - 0.5}
                  y2={yBase - 1}
                  stroke="var(--label-3, rgba(235,235,245,0.32))"
                  strokeWidth="1.5"
                  strokeDasharray="2 2"
                />
              )}

              {item.isTrainingDay && (
                <circle
                  data-training-day={item.d}
                  cx={cx}
                  cy={yBase + 6}
                  r={parsed.length > 45 ? 1.5 : 2.2}
                  fill="var(--acc)"
                />
              )}

              {(item.idx % labelEvery === 0) && (
                <text
                  x={cx}
                  y={H - 6}
                  textAnchor="middle"
                  fontSize="9"
                  fill="var(--label-2, rgba(235,235,245,0.6))"
                >
                  {item.label}
                </text>
              )}

              <rect
                data-day-hit={item.d}
                role="button"
                tabIndex={0}
                aria-pressed={isSelected}
                aria-label={
                  item.value != null
                    ? `${item.d} : ${fmtVal(item.value)} ${unit}`
                    : `${item.d} : non enregistré`
                }
                x={P.l + item.idx * slotW}
                y={P.t}
                width={slotW}
                height={plotH + 10}
                fill="transparent"
                style={{ cursor: 'pointer', outline: 'none' }}
                onClick={() => handleSelect(item)}
                onKeyDown={e => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    handleSelect(item)
                  }
                }}
              />
            </g>
          )
        })}

        {allTargetsEqual && (
          <line
            data-target-line="constant"
            x1={P.l}
            y1={Y(nonNullTargets[0])}
            x2={W - P.r}
            y2={Y(nonNullTargets[0])}
            stroke="var(--label-2, rgba(235,235,245,0.75))"
            strokeWidth="1.4"
            strokeDasharray="5 4"
            pointerEvents="none"
          />
        )}

        {steppedRuns.map((pts, idx) => (
          <polyline
            key={`target-step-${idx}`}
            data-target-line="stepped"
            points={pts}
            fill="none"
            stroke="var(--label-2, rgba(235,235,245,0.75))"
            strokeWidth="1.4"
            strokeDasharray="5 3"
            pointerEvents="none"
          />
        ))}
      </svg>

      {selectedDay && (
        <div
          data-day-tooltip="true"
          role="status"
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
            padding: '8px 10px',
            borderRadius: 10,
            background: 'var(--surface-2, rgba(128,128,128,0.16))',
            fontSize: 12,
          }}
        >
          <span style={{ fontWeight: 600 }}>
            {selectedDay.label} · {selectedDay.d}
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span>
              {selectedDay.value != null
                ? `${fmtVal(selectedDay.value)} ${unit}`
                : 'Non enregistré'}
            </span>
            {selectedDay.target != null && (
              <span style={{ color: 'var(--label-2, rgba(235,235,245,0.6))' }}>
                Cible : {fmtVal(selectedDay.target)} {unit}
              </span>
            )}
            {selectedDay.hasTrainingFlag && (
              <span
                style={{
                  padding: '2px 7px',
                  borderRadius: 999,
                  fontSize: 11,
                  fontWeight: 500,
                  background: selectedDay.isTrainingDay
                    ? 'var(--acc-soft, rgba(48,209,88,0.16))'
                    : 'var(--surface-3, rgba(128,128,128,0.22))',
                  color: selectedDay.isTrainingDay
                    ? 'var(--acc)'
                    : 'var(--label-2, rgba(235,235,245,0.6))',
                }}
              >
                {selectedDay.isTrainingDay ? 'Entraînement' : 'Repos'}
              </span>
            )}
          </span>
        </div>
      )}
    </div>
  )
}

function getQualityGaugeState(item) {
  const val = toNum(item.value)
  const safeVal = val != null ? Math.max(0, val) : 0
  const target = toNum(item.target)
  const hasTarget = target != null && target > 0

  if (!hasTarget) {
    return {
      status: 'unconfigured',
      barColor: 'var(--label-3, #64748b)',
      fillRatio: val != null && safeVal > 0 ? 0.3 : 0,
      hasTarget: false,
      safeVal,
      target: null,
    }
  }

  const ratio = safeVal / target
  if (item.kind === 'max') {
    const status = safeVal > target
      ? 'exceeded'
      : ratio >= 0.8
        ? 'near-limit'
        : 'within-limit'
    const barColor = status === 'exceeded'
      ? '#ef4444'
      : status === 'near-limit'
        ? '#f59e0b'
        : '#10b981'
    return {
      status,
      barColor,
      fillRatio: Math.min(1, ratio),
      hasTarget: true,
      safeVal,
      target,
    }
  }

  const status = ratio >= 1 ? 'goal-met' : ratio >= 0.5 ? 'building' : 'low'
  const barColor = status === 'goal-met'
    ? '#10b981'
    : status === 'building'
      ? '#4f8cff'
      : '#f59e0b'
  return {
    status,
    barColor,
    fillRatio: Math.min(1, ratio),
    hasTarget: true,
    safeVal,
    target,
  }
}

/**
 * List of horizontal quality gauges for micronutrients/hidden nutrients
 * (min targets vs max ceilings, plus neutral bar when target is unset).
 */
export function QualityGaugeList({ items = [] }) {
  const list = Array.isArray(items) ? items : []

  if (list.length === 0) {
    return (
      <p style={{ ...chartRootStyle, margin: 0, fontSize: 13, color: 'var(--label-2, rgba(235,235,245,0.6))' }}>
        Aucun indicateur de qualité disponible
      </p>
    )
  }

  return (
    <div style={{ ...chartRootStyle, display: 'grid', gap: 12 }}>
      {list.map((item, idx) => {
        const key = item.key ?? String(idx)
        const unit = item.unit ?? 'g'
        const state = getQualityGaugeState(item)
        const valText = item.value != null && toNum(item.value) != null
          ? fmtVal(state.safeVal)
          : '—'
        const barW = 240
        const barH = 8
        const fillW = state.fillRatio > 0 ? Math.max(4, state.fillRatio * barW) : 0

        return (
          <div
            key={key}
            data-quality-key={key}
            data-quality-status={state.status}
            style={{ display: 'grid', gap: 5 }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'baseline',
                justifyContent: 'space-between',
                gap: 8,
                fontSize: 13,
              }}
            >
              <span style={{ fontWeight: 500 }}>{item.label ?? key}</span>
              <span style={{ fontSize: 12, color: 'var(--label-2, rgba(235,235,245,0.6))' }}>
                <strong style={{ color: state.status === 'exceeded' ? '#ef4444' : 'var(--label, #ffffff)', fontWeight: 600 }}>
                  {valText}
                </strong>
                {state.hasTarget
                  ? ` / ${fmtVal(state.target)} ${unit}${item.kind === 'max' ? ' max' : ''}`
                  : ` ${unit} · sans cible`}
              </span>
            </div>

            <svg
              viewBox={`0 0 ${barW} ${barH}`}
              width="100%"
              height={barH}
              preserveAspectRatio="none"
              role="progressbar"
              aria-label={item.label ?? key}
              aria-valuemin={0}
              aria-valuemax={state.hasTarget ? state.target : undefined}
              aria-valuenow={toNum(item.value) != null ? state.safeVal : undefined}
              style={{ display: 'block', borderRadius: barH / 2, overflow: 'hidden' }}
            >
              <rect
                x="0"
                y="0"
                width={barW}
                height={barH}
                rx={barH / 2}
                fill="var(--surface-3, rgba(128,128,128,0.22))"
              />
              {fillW > 0 && (
                <rect
                  data-quality-fill={key}
                  x="0"
                  y="0"
                  width={fillW}
                  height={barH}
                  rx={barH / 2}
                  fill={state.barColor}
                  opacity={state.hasTarget ? 1 : 0.45}
                />
              )}
            </svg>
          </div>
        )
      })}
    </div>
  )
}

/**
 * Horizontal visual calibration gauge displaying pace alignment
 * ('too-fast' | 'well-calibrated' | 'too-slow') for cut, bulk, or maintenance.
 */
export function CalibrationScale({
  status,
  mode,
  dailyDeltaKcal = 0,
  weeklyKg = 0,
  label = '',
}) {
  const zone = CALIBRATION_ZONES.find(z => z.key === status) ?? null
  const modeText = MODE_LABELS[mode] ?? ''
  const title = label || modeText || 'Calibration'
  const deltaNum = toNum(dailyDeltaKcal) ?? 0
  const weeklyNum = toNum(weeklyKg) ?? 0
  const deltaPrefix = deltaNum > 0 ? '+' : ''
  const weeklyPrefix = weeklyNum > 0 ? '+' : ''

  return (
    <div
      data-calibration-status={status ?? 'unknown'}
      data-calibration-mode={mode ?? 'unknown'}
      style={{ ...chartRootStyle, display: 'grid', gap: 8 }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 8,
          flexWrap: 'wrap',
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 600 }}>
          {title}
          {label && modeText ? (
            <span style={{ fontWeight: 400, color: 'var(--label-2, rgba(235,235,245,0.6))' }}>
              {' · '}
              {modeText}
            </span>
          ) : null}
        </span>
        <span style={{ fontSize: 12, color: 'var(--label-2, rgba(235,235,245,0.6))' }}>
          {deltaPrefix}{fmtInt(deltaNum)} kcal/j · {weeklyPrefix}{fmtVal(weeklyNum, 2)} kg/sem
        </span>
      </div>

      <svg
        viewBox="0 0 320 44"
        width="100%"
        role="img"
        aria-label={
          zone
            ? `${title} : ${zone.label} (${deltaPrefix}${fmtInt(deltaNum)} kcal/j, ${weeklyPrefix}${fmtVal(weeklyNum, 2)} kg/sem)`
            : `${title} : calibration indisponible`
        }
        style={{ display: 'block', width: '100%', height: 'auto' }}
      >
        <rect x="4" y="10" width="102" height="10" rx="5" fill="#f59e0b" opacity="0.28" />
        <rect x="109" y="10" width="102" height="10" rx="5" fill="#10b981" opacity="0.35" />
        <rect x="214" y="10" width="102" height="10" rx="5" fill="#4f8cff" opacity="0.28" />

        {zone && (
          <circle
            data-calibration-marker={zone.key}
            cx={zone.x}
            cy="15"
            r="7"
            fill={zone.color}
            stroke="var(--bg, #000000)"
            strokeWidth="2.5"
          />
        )}

        <text
          x="55"
          y="36"
          textAnchor="middle"
          fontSize="10"
          fontWeight={status === 'too-fast' ? '600' : '400'}
          fill={status === 'too-fast' ? '#f59e0b' : 'var(--label-2, rgba(235,235,245,0.6))'}
        >
          Trop rapide
        </text>
        <text
          x="160"
          y="36"
          textAnchor="middle"
          fontSize="10"
          fontWeight={status === 'well-calibrated' ? '600' : '400'}
          fill={status === 'well-calibrated' ? '#10b981' : 'var(--label-2, rgba(235,235,245,0.6))'}
        >
          Zone idéale ✅
        </text>
        <text
          x="265"
          y="36"
          textAnchor="middle"
          fontSize="10"
          fontWeight={status === 'too-slow' ? '600' : '400'}
          fill={status === 'too-slow' ? '#4f8cff' : 'var(--label-2, rgba(235,235,245,0.6))'}
        >
          Trop lent
        </text>
      </svg>
    </div>
  )
}
