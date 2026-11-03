import { useCallback, useEffect, useRef, useState, useId } from 'react'
import { Button, SearchField } from '../../components/ui.jsx'
import { t, getLang } from '../../lib/i18n.js'
import { MOBILE } from '../../lib/mobile.js'
import { scanCode } from '../../lib/scan.js'
import { NutrientValues, FoodSource, fmt, labels } from './common.jsx'
import CameraScan from '../../components/CameraScan.jsx'
import { productDecoder, scannedBarcode } from '../../lib/nutrition/catalog/scan.js'

const messages = {
  'invalid-query': 'Enter between 2 and 120 characters to search.', 'invalid-barcode': 'Enter an 8, 12, 13 or 14 digit barcode.',
  'provider-unavailable': 'The catalogue is unavailable. Your local foods remain available.',
  'not-found': 'This product is not listed in Open Food Facts.', 'network-error': 'The catalogue is unavailable. Your local foods remain available.',
  'rate-limited': 'The catalogue request limit was reached. Wait before trying again.', 'request-in-progress': 'A catalogue request is already running. Wait before trying again.',
  'invalid-response': 'The catalogue returned invalid data. Nothing was saved.', 'invalid-nutrients': 'This product has inconsistent nutrition data and cannot be added.',
  'inconsistent-energy': 'This product has inconsistent nutrition data and cannot be added.', 'barcode-mismatch': 'The returned product does not match this barcode.',
  'response-too-large': 'The catalogue response exceeds the supported size.',
  'ambiguous-barcode': 'Several local products share this barcode. Select a product by name.',
}
/** Local autocomplete uses manual-selection APG combobox; remote stays explicit. Scope/unmount/request epochs reject out-of-order responses;
 * selecting a result only prepares an editor, and does not publish a meal. */
export default function FoodCatalog({ service, onChoose, autoFocus = false }) {
  const [query, setQuery] = useState(''), [mode, setMode] = useState('text'), [loading, setLoading] = useState(false)
  const [result, setResult] = useState(null), [selected, setSelected] = useState(null), [error, setError] = useState(null), [camera, setCamera] = useState(null)
  const [local, setLocal] = useState(false), [open, setOpen] = useState(false), [activeOption, setActiveOption] = useState(-1), [composing, setComposing] = useState(false)
  const input = useRef(null), timer = useRef(null), scanActive = useRef(false), listId = useId()
  const detail = useRef(null)
  useEffect(() => { if (selected) detail.current?.focus() }, [selected])
  const task = useRef(null), epoch = useRef(0), alive = useRef(true)
  useEffect(() => {
    alive.current = true; setLocal(false); setQuery(''); setResult(null); setSelected(null); setError(null); setOpen(false); setActiveOption(-1); setLoading(false); setCamera(null)
    const controller = new AbortController()
    service.catalog.capabilities?.({ signal:controller.signal }).then(value => {
      if (!controller.signal.aborted && alive.current) { service.assertCurrent(); setLocal(value.textSearch === 'local') }
    }).catch(() => {})
    return () => { alive.current = false; epoch.current++; task.current?.abort(); controller.abort(); clearTimeout(timer.current) }
  }, [service])
  const cancel = () => { clearTimeout(timer.current); epoch.current++; task.current?.abort(); setLoading(false) }
  const run = async (value = query, page = 1, kind = mode) => {
    cancel(); const token = ++epoch.current, controller = new AbortController(); task.current = controller
    setLoading(true); setError(null); setSelected(null); setResult(null); setActiveOption(-1); setOpen(local && kind === 'text' && document.activeElement === input.current)
    try {
      const options = { signal: controller.signal, language: getLang().slice(0, 2), page, localOnly:local && kind === 'text' }
      // A failed initial capability probe must not latch V1 unavailable forever.
      // Only retry on an actual search; never downgrade to a food provider.
      if (service.catalog.localOnly && service.catalog.localReady === false) {
        await service.catalog.capabilities({signal:controller.signal}); service.assertCurrent()
      }
      const found = kind === 'barcode' ? await service.catalog.product(value.trim(), options) : await service.catalog.search(value, options)
      service.assertCurrent()
      if (alive.current && token === epoch.current) { setResult({ ...found, query: value, mode: kind }); if (found.product) setSelected(found.product) }
    } catch (failure) { if (alive.current && token === epoch.current && failure.name !== 'AbortError') setError(failure) }
    finally { if (alive.current && token === epoch.current) setLoading(false) }
  }
  // Debounce only a positively identified local catalogue. Search never writes
  // Nutrition partitions. Epochs and AbortSignals protect navigation/session changes.
  useEffect(() => {
    if (local && mode === 'text' && !composing && query.trim().length >= 2) timer.current = setTimeout(() => run(query), 300)
    return () => clearTimeout(timer.current)
  }, [query, local, mode, composing])
  useEffect(() => { if (activeOption >= 0) document.getElementById(`${listId}-${activeOption}`)?.scrollIntoView?.({ block:'nearest' }) }, [activeOption, listId])
  const changeQuery = value => { cancel(); setQuery(value); setResult(null); setSelected(null); setError(null); setActiveOption(-1); setOpen(false) }
  const choose = async product => {
    cancel(); setOpen(false); setActiveOption(-1)
    if (!local) { setSelected(product); return }
    // V1 rereads the pinned local UUID, with no provider fallback. Legacy TSV
    // mode retains its explicit v3 hydration. Neither read writes user data.
    const token = ++epoch.current, controller = new AbortController(); task.current = controller
    setLoading(true); setError(null); setSelected(null)
    try {
      const read = service.catalog.localOnly ? service.catalog.localProduct.bind(service.catalog) : service.catalog.product.bind(service.catalog)
      const found = await read(service.catalog.localOnly ? product.id : product.code, { signal:controller.signal, language:getLang().slice(0,2) })
      service.assertCurrent()
      if (alive.current && token === epoch.current) { setSelected(found.product); setResult(previous=>({...previous,...found})) }
    } catch (failure) { if (alive.current && token === epoch.current && failure.name !== 'AbortError') setError(failure) }
    finally { if (alive.current && token === epoch.current) setLoading(false) }
  }
  const keyboard = event => {
    if (!local || mode !== 'text' || composing || event.isComposing) return
    const products = result?.products ?? []
    if (event.key === 'Escape') { event.preventDefault(); cancel(); setOpen(false); setActiveOption(-1) }
    else if (['ArrowDown','ArrowUp'].includes(event.key) && products.length && !selected) {
      event.preventDefault(); setOpen(true)
      setActiveOption(index => event.key === 'ArrowDown' ? Math.min(products.length - 1, index + 1) : index < 0 ? products.length - 1 : Math.max(0,index - 1))
    } else if (event.key === 'Enter' && open && activeOption >= 0 && products[activeOption]) { event.preventDefault(); choose(products[activeOption]) }
  }
  const explicitSearch = (value = query, page = 1, kind = mode) => {
    if (local && kind === 'text') input.current?.focus()
    return run(value, page, kind)
  }
  const onFound = useCallback(code => {
    if (!alive.current) return
    setCamera(null)
    try { service.assertCurrent(); const value = scannedBarcode(code); setMode('barcode'); setQuery(value); run(value, 1, 'barcode') } catch (failure) { setError(failure) }
  }, [service])
  const scan = async () => {
    if (scanActive.current) return
    scanActive.current = true
    cancel(); setError(null); const token = ++epoch.current
    try {
      if (MOBILE) { const code = await scanCode({ product: true }); service.assertCurrent(); if (alive.current && token === epoch.current && code) onFound(code) }
      else { const decode = await productDecoder(); if (alive.current && token === epoch.current) setCamera(() => decode) }
    } catch (failure) { if (alive.current && token === epoch.current) setError({ code: failure?.message === 'permission-denied' ? 'camera-permission-denied' : 'camera-unavailable' }) }
    finally { scanActive.current = false }
  }
  if (camera) return <CameraScan decode={camera} hint="Point the camera at the product barcode" onFound={onFound} onCancel={() => setCamera(null)} />
  return <div className="nutrition-catalog">
    <p className="muted small">{service.catalog.localOnly ? `${t('Food catalogue')} · wger / USDA / Open Food Facts` : local ? t('Source: Open Food Facts contributors') : t('Search Open Food Facts explicitly. Products are contributed by the community; values may be incomplete.')}</p>
    <div className="nutrition-actions nutrition-catalog-modes"><Button size="sm" aria-pressed={mode === 'text'} onClick={() => { cancel(); setMode('text'); setResult(null); setSelected(null); setQuery(''); setError(null) }}>{t('Product name or brand')}</Button>
      <Button size="sm" aria-pressed={mode === 'barcode'} onClick={() => { cancel(); setMode('barcode'); setResult(null); setSelected(null); setQuery(''); setError(null) }}>{t('Barcode')}</Button><Button size="sm" icon="camera" className="nutrition-icon-action" aria-label={t('Scan product barcode')} title={t('Scan product barcode')} disabled={loading} onClick={scan}><span className="sr-only">{t('Scan product barcode')}</span></Button></div>
    <form onSubmit={e => { e.preventDefault(); if (!loading) explicitSearch() }}>
      <SearchField ref={input} autoFocus={autoFocus} aria-label={t(mode === 'text' ? service.catalog.localOnly ? 'Food catalogue' : 'Search Open Food Facts' : 'Product barcode')} value={query}
        onChange={e => changeQuery(e.target.value)} onClear={() => { changeQuery(''); input.current?.focus() }}
        onCompositionStart={() => { cancel(); setComposing(true) }} onCompositionEnd={() => setComposing(false)}
        onKeyDown={keyboard} onFocus={() => { if (local && !selected) setOpen(true) }} onBlur={() => { setOpen(false); setActiveOption(-1) }}
        {...(local && mode === 'text' ? { role:'combobox', 'aria-autocomplete':'list', 'aria-haspopup':'listbox', 'aria-controls':listId,
          'aria-expanded':open && !selected && !!result?.products?.length, 'aria-activedescendant':open && activeOption >= 0 ? `${listId}-${activeOption}` : undefined } : {})}
        inputMode={mode === 'barcode' ? 'numeric' : 'text'} maxLength={mode === 'barcode' ? 14 : 120} />
      <div className="nutrition-actions"><Button type="submit" disabled={loading || !query.trim()}>{t('Search')}</Button>{loading && <Button type="button" onClick={cancel}>{t('Cancel')}</Button>}</div>
    </form>
    {loading && <p role="status">{t('Searching catalogue…')}</p>}
    {error && <p className="nutrition-error" role="alert">{error.code === 'provider-unavailable' && `${t(mode === 'text' ? 'Product name or brand' : 'Barcode')}: `}{t(error.code === 'camera-permission-denied' ? 'Camera permission is needed to scan. Enable it in Settings.' : error.code === 'camera-unavailable' ? 'Barcode camera scanning is unavailable here. Type the code instead.' : error.code === 'not-found' && service.catalog.localOnly ? 'No catalogue products found' : messages[error.code] ?? 'The catalogue is unavailable. Your local foods remain available.')}{error.retryAfter ? ` ${t('Try again in {0} seconds.', error.retryAfter)}` : ''}</p>}
    {(result?.cached || result?.validation?.stale) && <p className="muted small">{t('Showing cached catalogue data')}</p>}
    {result?.products && !result.products.length && <p role="status">{t('No catalogue products found')}</p>}
    {result?.rejected > 0 && <p className="muted small">{t('{0} invalid products were omitted.', result.rejected)}</p>}
    {(!selected || (local && mode === 'text')) && <div className="nutrition-results" id={local && mode === 'text' ? listId : undefined}
      role={local && mode === 'text' ? 'listbox' : undefined} aria-label={local && mode === 'text' ? t(service.catalog.localOnly ? 'Food catalogue' : 'Search Open Food Facts') : undefined}
      hidden={local && mode === 'text' && (!open || !!selected)}>{result?.products?.map((product, index) => <button className="nutrition-result" key={product.id ?? product.code}
        {...(local && mode === 'text' ? { id:`${listId}-${index}`, role:'option', tabIndex:-1, 'aria-selected':activeOption === index,
          onPointerDown:e => e.preventDefault() } : {})} disabled={loading} onClick={() => choose(product)}>
      <strong>{product.name}</strong><span>{product.brand}</span><span>{fmt(product.food?.nutrients.kcal)} kcal{product.reference ? ` / ${fmt(product.reference.amount)} ${product.reference.unit}` : ''}</span>
      <span>{['protein', 'carbs', 'fat'].map(k => `${t(labels[k])}: ${fmt(product.food?.nutrients[k])} g`).join(' · ')}</span>
      {!product.food && <span className="muted small">{t('No reliable nutrition reference is available. This product cannot be added.')}</span>}
      {product.food?.source?.kind==='open-food-facts' && <span className="muted small">{t('Source: Open Food Facts contributors')} · ODbL / DbCL</span>}
    </button>)}</div>}
    {selected && <section className="card nutrition-product" aria-label={t('Catalogue product')}>
      <h3 ref={detail} tabIndex={-1}>{selected.name}</h3><p>{selected.brand}</p>{selected.originalName && <p className="muted small">openGym (fr) · {selected.originalName}</p>}{selected.code && <p className="muted small">{t('Barcode')}: {selected.code}</p>}
      {selected.image && <img src={selected.image} loading="lazy" decoding="async" width="100" height="100" alt={selected.name} referrerPolicy="no-referrer" onError={e => { e.currentTarget.hidden = true }} />}
      {selected.reference && <p>{t('Nutrition per {0} {1}', fmt(selected.reference.amount), selected.reference.unit)}</p>}
      {selected.food && <NutrientValues values={selected.food.nutrients} />}
      {result?.validation && <p className="muted small">{t('Date')}: <time dateTime={result.validation.capturedAt}>{new Intl.DateTimeFormat(getLang(),{dateStyle:'medium'}).format(new Date(result.validation.capturedAt))}</time></p>}
      {selected.serving && <p>{t('Portion')}: {selected.serving}</p>}
      {selected.warnings.includes('missing-values') && <p className="muted small">{t('Some nutrition values are unknown. Journal totals will remain incomplete.')}</p>}
      {!selected.food && <p role="status">{t('No reliable nutrition reference is available. This product cannot be added.')}</p>}
      <div className="nutrition-actions">{selected.food && <Button variant="primary" onClick={() => onChoose(selected.food)}>{t('Choose quantity')}</Button>}<Button onClick={() => { setSelected(null); setOpen(true); input.current?.focus() }}>{t('Back to results')}</Button></div>
    </section>}
    {result?.products && (result.hasMore || result.page > 1) && !selected && <div className="nutrition-actions"><Button disabled={loading || result.page === 1} onClick={() => explicitSearch(result.query, result.page - 1, result.mode)}>{t('Prev')}</Button><span>{t('Page {0}', result.page)}</span><Button disabled={loading || !result.hasMore} onClick={() => explicitSearch(result.query, result.page + 1, result.mode)}>{t('Next')}</Button></div>}
    {service.catalog.localOnly ? <><p className="muted small"><a href="https://wger.de" target="_blank" rel="noopener noreferrer">wger</a> · {t('Food catalogue')}</p>{selected?.food && <FoodSource food={selected.food} />}</> : <p className="muted small"><a href={selected?.sourceUrl ?? 'https://world.openfoodfacts.org'} target="_blank" rel="noopener noreferrer">{t('Source: Open Food Facts contributors')}</a> · <a href="https://opendatacommons.org/licenses/odbl/1-0/" target="_blank" rel="noopener noreferrer">ODbL</a> / DbCL{selected?.image && <> · <a href="https://creativecommons.org/licenses/by-sa/3.0/" target="_blank" rel="noopener noreferrer">{t('Product image: CC BY-SA')}</a></>}</p>}
  </div>
}
