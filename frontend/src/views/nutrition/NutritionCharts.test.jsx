// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  NUTRITION_COLORS,
  CalorieRing,
  MacroDonut,
  MealStackedBar,
  DailyTargetBars,
  QualityGaugeList,
  CalibrationScale,
} from './NutritionCharts.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container
let root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function render(ui) {
  act(() => root.render(ui))
}

describe('NUTRITION_COLORS', () => {
  it('exports expected semantic nutrition color tokens', () => {
    expect(NUTRITION_COLORS).toEqual({
      kcal: 'var(--acc)',
      protein: '#4f8cff',
      carbs: '#f59e0b',
      fat: '#f43f5e',
      fiber: '#10b981',
      water: '#06b6d4',
      sugar: '#a855f7',
      saturatedFat: '#ef4444',
      sodium: '#64748b',
    })
  })
})

describe('CalorieRing', () => {
  it('renders remaining kcal and consumed/target summary with accessible role', () => {
    render(<CalorieRing consumed={1450} target={2200} remaining={750} />)
    const ring = container.querySelector('[role="img"]')
    expect(ring).toBeTruthy()
    expect(ring.getAttribute('aria-label')).toContain('1450')
    expect(ring.getAttribute('aria-label')).toContain('2200')
    expect(ring.textContent).toContain('750')
    expect(ring.textContent).toContain('1450 / 2200 kcal')
    const circles = container.querySelectorAll('circle')
    expect(circles).toHaveLength(2)
    expect(circles[1].getAttribute('stroke')).toBe(NUTRITION_COLORS.kcal)
  })

  it('uses amber warning for mild exceedance and coral red for significant exceedance', () => {
    render(<CalorieRing consumed={2100} target={2000} remaining={-100} />)
    expect(container.textContent).toContain('+100')
    expect(container.querySelectorAll('circle')[1].getAttribute('stroke')).toBe('#f59e0b')

    render(<CalorieRing consumed={2400} target={2000} remaining={-400} />)
    expect(container.textContent).toContain('+400')
    expect(container.querySelectorAll('circle')[1].getAttribute('stroke')).toBe('#ef4444')
  })

  it('handles zero consumed and missing target cleanly', () => {
    render(<CalorieRing consumed={0} target={2000} />)
    expect(container.textContent).toContain('2000')
    expect(container.querySelectorAll('circle')).toHaveLength(1)

    render(<CalorieRing consumed={1230} target={null} subtitle="Apport du jour" />)
    expect(container.textContent).toContain('1230')
    expect(container.textContent).toContain('Apport du jour')
    expect(container.querySelectorAll('circle')).toHaveLength(1)
  })
})

describe('MacroDonut', () => {
  it('renders empty state gracefully when all macros are zero', () => {
    render(
      <MacroDonut
        kcalFromMacros={{ protein: 0, carbs: 0, fat: 0 }}
        grams={{ protein: 0, carbs: 0, fat: 0 }}
      />
    )
    expect(container.textContent).toContain('0 kcal')
    expect(container.textContent).toContain('Aucune donnée')
    expect(container.querySelectorAll('[data-slice]')).toHaveLength(0)
  })

  it('supports clicking and focusing slices to inspect % / kcal / g and toggling off', () => {
    render(
      <MacroDonut
        grams={{ protein: 125, carbs: 250, fat: 55.5 }}
        targetPercents={{ protein: 25, carbs: 50, fat: 25 }}
      />
    )
    // 125*4 = 500, 250*4 = 1000, 55.5*9 = 499.5 -> total ~2000 kcal
    const center = () => container.querySelector('[data-donut-center="true"]').textContent
    expect(center()).toContain('2000')
    expect(container.textContent).toContain('cible 25%')
    expect(container.textContent).toContain('cible 50%')

    const proteinSlice = container.querySelector('[data-slice="protein"]')
    expect(proteinSlice).toBeTruthy()

    // Click selects protein
    act(() => {
      proteinSlice.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      proteinSlice.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(center()).toContain('Protéines')
    expect(center()).toContain('25%')
    expect(center()).toContain('500 kcal')
    expect(center()).toContain('125 g')

    // Click again toggles off
    act(() => {
      proteinSlice.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      proteinSlice.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(center()).toContain('2000')

    // Focus selects carbs slice
    const carbsSlice = container.querySelector('[data-slice="carbs"]')
    act(() => {
      carbsSlice.focus()
    })
    expect(center()).toContain('Glucides')
    expect(center()).toContain('50%')
    expect(center()).toContain('1000 kcal')
    expect(center()).toContain('250 g')
  })

  it('respects custom labels and explicit kcalFromMacros', () => {
    render(
      <MacroDonut
        kcalFromMacros={{ protein: 400, carbs: 400, fat: 200 }}
        grams={{ protein: 100, carbs: 100, fat: 22 }}
        labels={{ protein: 'Protein', carbs: 'Carbs', fat: 'Fat' }}
      />
    )
    expect(container.textContent).toContain('Protein')
    expect(container.textContent).toContain('Carbs')
    expect(container.textContent).toContain('Fat')
    expect(container.textContent).toContain('1000')
  })
})

describe('MealStackedBar', () => {
  it('renders proportional meal segments and compact legend', () => {
    render(
      <MealStackedBar
        meals={[
          { key: 'breakfast', label: 'Petit-déjeuner', kcal: 500, protein: 30 },
          { key: 'lunch', label: 'Déjeuner', kcal: 700, protein: 50 },
          { key: 'dinner', label: 'Dîner', kcal: 600, protein: 45 },
          { key: 'snack', label: 'Collations', kcal: 200, protein: 15 },
        ]}
      />
    )
    expect(container.querySelectorAll('[data-meal-segment]')).toHaveLength(4)
    const breakfastSeg = container.querySelector('[data-meal-segment="breakfast"]')
    const lunchSeg = container.querySelector('[data-meal-segment="lunch"]')
    expect(Number(lunchSeg.getAttribute('width'))).toBeGreaterThan(Number(breakfastSeg.getAttribute('width')))
    expect(container.textContent).toContain('25% · 500 kcal · 30 g prot.')
    expect(container.textContent).toContain('35% · 700 kcal · 50 g prot.')
  })

  it('handles 0 total kcal and empty meals gracefully', () => {
    render(
      <MealStackedBar
        meals={[
          { key: 'breakfast', label: 'Petit-déjeuner', kcal: 0, protein: 0 },
          { key: 'lunch', label: 'Déjeuner', kcal: 0, protein: 0 },
        ]}
      />
    )
    expect(container.querySelectorAll('[data-meal-segment]')).toHaveLength(0)
    expect(container.textContent).toContain('0 kcal')
    expect(container.textContent).toContain('0% · 0 kcal · 0 g prot.')

    render(<MealStackedBar meals={[]} />)
    expect(container.textContent).toContain('Aucun repas enregistré')
  })
})

describe('DailyTargetBars', () => {
  it('draws empty slots for unlogged days and constant dashed target line', () => {
    const days = [
      { d: '2026-10-05', label: 'Lun', value: 2100, target: 2200, isTrainingDay: true },
      { d: '2026-10-06', label: 'Mar', value: null, target: 2200, isTrainingDay: false },
      { d: '2026-10-07', label: 'Mer', value: 2250, target: 2200, isTrainingDay: true },
    ]
    render(<DailyTargetBars days={days} metric="kcal" unit="kcal" />)

    expect(container.querySelector('[data-bar="2026-10-05"]')).toBeTruthy()
    expect(container.querySelector('[data-bar="2026-10-06"]')).toBeNull()
    expect(container.querySelector('[data-unlogged="2026-10-06"]')).toBeTruthy()
    expect(container.querySelector('[data-target-line="constant"]')).toBeTruthy()
    expect(container.querySelector('[data-target-line="stepped"]')).toBeNull()
    expect(container.querySelectorAll('[data-training-day]')).toHaveLength(2)
  })

  it('renders stepped dashed polyline when training and rest targets differ and handles day selection', () => {
    const onSelectDay = vi.fn()
    const days = [
      { d: '2026-10-05', label: 'Lun', value: 2400, target: 2500, isTrainingDay: true },
      { d: '2026-10-06', label: 'Mar', value: 1950, target: 2000, isTrainingDay: false },
      { d: '2026-10-07', label: 'Mer', value: 2450, target: 2500, isTrainingDay: true },
    ]
    render(<DailyTargetBars days={days} metric="kcal" unit="kcal" onSelectDay={onSelectDay} />)

    expect(container.querySelector('[data-target-line="constant"]')).toBeNull()
    const stepped = container.querySelector('[data-target-line="stepped"]')
    expect(stepped).toBeTruthy()
    expect(stepped.tagName.toLowerCase()).toBe('polyline')

    const hit = container.querySelector('[data-day-hit="2026-10-06"]')
    act(() => {
      hit.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onSelectDay).toHaveBeenCalledWith('2026-10-06')
    const tip = container.querySelector('[data-day-tooltip="true"]')
    expect(tip).toBeTruthy()
    expect(tip.textContent).toContain('2026-10-06')
    expect(tip.textContent).toContain('1950 kcal')
    expect(tip.textContent).toContain('Cible : 2000 kcal')
    expect(tip.textContent).toContain('Repos')
  })

  it('supports 30 and 90 days and empty state', () => {
    const ninetyDays = Array.from({ length: 90 }, (_, i) => ({
      d: `2026-01-${String((i % 28) + 1).padStart(2, '0')}-${i}`,
      label: `J${i + 1}`,
      value: i % 5 === 0 ? null : 2000 + (i % 300),
      target: i % 2 === 0 ? 2400 : 2000,
      isTrainingDay: i % 2 === 0,
    }))
    render(<DailyTargetBars days={ninetyDays} />)
    expect(container.querySelectorAll('[data-day-hit]')).toHaveLength(90)
    expect(container.querySelector('[data-target-line="stepped"]')).toBeTruthy()

    render(<DailyTargetBars days={[]} />)
    expect(container.textContent).toContain('Aucune donnée sur la période')
  })
})

describe('QualityGaugeList', () => {
  it('distinguishes min targets, max ceilings (<80%, 80-100%, >100%), and unconfigured targets', () => {
    render(
      <QualityGaugeList
        items={[
          { key: 'fiberMet', label: 'Fibres', value: 32, target: 30, kind: 'min', unit: 'g' },
          { key: 'fiberMid', label: 'Fibres (en cours)', value: 18, target: 30, kind: 'min', unit: 'g' },
          { key: 'sugarOk', label: 'Sucres', value: 25, target: 50, kind: 'max', unit: 'g' },
          { key: 'satWarn', label: 'Graisses saturées', value: 18, target: 20, kind: 'max', unit: 'g' },
          { key: 'sodiumOver', label: 'Sodium', value: 2600, target: 2300, kind: 'max', unit: 'mg' },
          { key: 'waterUnset', label: 'Eau', value: 1.8, target: null, kind: 'min', unit: 'L' },
        ]}
      />
    )

    expect(container.querySelector('[data-quality-key="fiberMet"]').getAttribute('data-quality-status')).toBe('goal-met')
    expect(container.querySelector('[data-quality-fill="fiberMet"]').getAttribute('fill')).toBe('#10b981')

    expect(container.querySelector('[data-quality-key="fiberMid"]').getAttribute('data-quality-status')).toBe('building')
    expect(container.querySelector('[data-quality-fill="fiberMid"]').getAttribute('fill')).toBe('#4f8cff')

    expect(container.querySelector('[data-quality-key="sugarOk"]').getAttribute('data-quality-status')).toBe('within-limit')
    expect(container.querySelector('[data-quality-fill="sugarOk"]').getAttribute('fill')).toBe('#10b981')

    expect(container.querySelector('[data-quality-key="satWarn"]').getAttribute('data-quality-status')).toBe('near-limit')
    expect(container.querySelector('[data-quality-fill="satWarn"]').getAttribute('fill')).toBe('#f59e0b')

    expect(container.querySelector('[data-quality-key="sodiumOver"]').getAttribute('data-quality-status')).toBe('exceeded')
    expect(container.querySelector('[data-quality-fill="sodiumOver"]').getAttribute('fill')).toBe('#ef4444')

    expect(container.querySelector('[data-quality-key="waterUnset"]').getAttribute('data-quality-status')).toBe('unconfigured')
    expect(container.textContent).toContain('1.8 L · sans cible')
  })
})

describe('CalibrationScale', () => {
  it('positions marker dot for too-fast, well-calibrated, and too-slow states', () => {
    render(<CalibrationScale status="well-calibrated" mode="cut" dailyDeltaKcal={-350} weeklyKg={-0.32} label="Objectif perte" />)
    expect(container.querySelector('[data-calibration-marker="well-calibrated"]').getAttribute('cx')).toBe('160')
    expect(container.textContent).toContain('Objectif perte · Sèche')
    expect(container.textContent).toContain('-350 kcal/j')
    expect(container.textContent).toContain('-0.32 kg/sem')
    expect(container.textContent).toContain('Zone idéale ✅')

    render(<CalibrationScale status="too-fast" mode="cut" dailyDeltaKcal={-800} weeklyKg={-0.75} />)
    expect(container.querySelector('[data-calibration-marker="too-fast"]').getAttribute('cx')).toBe('53')

    render(<CalibrationScale status="too-slow" mode="bulk" dailyDeltaKcal={120} weeklyKg={0.1} />)
    expect(container.querySelector('[data-calibration-marker="too-slow"]').getAttribute('cx')).toBe('267')
    expect(container.textContent).toContain('Prise de masse')
    expect(container.textContent).toContain('+120 kcal/j')
  })
})
