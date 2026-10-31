# Plan: Trader + Watchdog local para Kraken Spot Paper

> **Nota histórica.** Documento de diseño original (2026-10-18), anterior a la
> implementación. Varios parámetros y decisiones cambiaron después (K=1.25,
> TARGET_ATR=0.75, HOLD_MAX_DAYS=10, MAX_CONCURRENT=2, reconciliación, HALTED…).
> La referencia actual es el `README.md` y el `CHANGELOG.md` en la raíz.

Diseño de un sistema autónomo para operar un workspace de **Kraken Spot Paper**
usando `kraken-cli` v0.4.1, análogo al sistema futures de `/home/oc/challenge` pero
adaptado a las limitaciones reales del spot paper.

> Estado: **solo planificación**. No se ha implementado ni se ha colocado ninguna orden.
> Directorio objetivo: `/home/oc/kraken-spot`.

---

## 0. Diferencias críticas vs. el sistema futures (no ignorar)

| Tema | Futures paper (`/home/oc/challenge`) | Spot paper (`kraken paper`) |
|---|---|---|
| Dirección | Long + short | **Solo long** (no hay short en spot paper) |
| Fees | 0.05%/lado | **0.26%/lado** (0.52% round-trip) |
| Stop/Take-profit | Órdenes reales `stop`/`take-profit`, `reduce-only`, trigger mark | **No existen**. Solo `market`/`limit`. La protección es por software (polling) |
| Alcance | Global, sin workspace | **Workspace-scoped** (`--workspace <name>` o `KRAKEN_WORKSPACE`) |
| Capital default | $1000 | $10000 (configurable al crear; usar $1000 para paridad con el challenge) |
| Lock de estado | Mutex en futures paper | Journal del workspace; asumir contención similar, reusar retries |
| Exposición | Apalancada opcional (1x elegido) | Sin apalancamiento (spot) |

Consecuencia principal: **en spot paper no hay protección si el daemon cae**.
El runner es el stop. Por eso el watchdog y el ciclo de 45s son más importantes
aquí que en futures, y conviene además colocar **limit sells resting** como
take-profit pasivo siempre que sea posible.

---

## 1. Objetivo y reglas (configurables)

Reutilizar la semántica del challenge para comparabilidad, pero parametrizable:

- `START = 1000` USD (workspace creado con `--capital 1000`)
- `TARGET = +12% = 1120` (PASS)
- `FLOOR = -3% = 970` (BUST, estático desde el inicio)
- Sin límite diario ni temporal
- Prioridad: (1) target, (2) no bust, (3) no riesgo innecesario

Workspace dedicado recomendado: `spotbot` (no reusar `getfunded`, que es libro
de referencia del challenge futures).

---

## 2. Estructura de archivos (`/home/oc/kraken-spot`)

```
kraken-spot/
├── PLAN.md                 (este documento)
├── ctl.mjs                 # wrapper kraken + RULES + equity + state + sizing
├── spot.mjs                # wrapper spot paper: status, balance, orders, buy, sell, cancel
├── trader.mjs              # UN ciclo: manage() + entry()
├── runner.mjs              # daemon 45s, timeout 300s, max 8 fallos
├── watchdog.sh             # revive runner si no está vivo
├── riskpolicy.mjs          # ladder de riesgo (adaptada a spot/fees)
├── validate.mjs            # checks de consistencia
├── tests.mjs               # tests puros sin red
├── resume.sh               # restauración post-reboot (sin órdenes)
├── state.json, fstate.json  # estado local
├── trades.jsonl, equity.csv, bot.log, runner.state.json, runner.err
```

Convención de nombres: mantener `fstate.json` por compatibilidad conceptual, o
renombrar a `state.json` único. Recomendación: un solo `state.json` con
`positions`, `tradeSeq`, `seenFills`, etc.

---

## 3. Wrapper CLI (`ctl.mjs` + `spot.mjs`)

### 3.1 `kraken()` con retries de lock

Copiar el patrón de `/home/oc/challenge/ctl.mjs`:

- `execFileSync('/home/oc/bin/kraken', args, ...)`
- Parsear JSON de la última línea que empiece con `{`/`[`
- Si el error contiene `in use by another process`, reintentar 8× con backoff
  400ms..~3.2s
- `allowFail` para llamadas opcionales

### 3.2 Comandos spot a usar

- `kraken --workspace spotbot paper status -o json`
- `kraken --workspace spotbot paper balance -o json`
- `kraken --workspace spotbot paper orders -o json`
- `kraken --workspace spotbot paper buy <PAIR> <VOL> --type market -o json`
- `kraken --workspace spotbot paper sell <PAIR> <VOL> --type market -o json`
- `kraken --workspace spotbot paper cancel --order-id <ID> -o json`
- `kraken --workspace spotbot paper cancel-all -o json`
- `kraken --workspace spotbot paper history -o json`
- Señal: `kraken ohlc <PAIR> --interval 60 -o json`, `kraken ticker <PAIR> -o json`

Alternativa: setear `KRAKEN_WORKSPACE=spotbot` en el entorno del runner en vez
de pasar `--workspace` cada vez. Recomendación: pasar `--workspace` explícito
para que `ctl.mjs` sea autocontenido y no dependa del entorno.

### 3.3 Equidad

`status` devuelve `current_value` (no `equity`). Usar `st.current_value`.
`balance` devuelve `balances.USD.available/total`.

---

## 4. State local

`state.json`:
```json
{
  "createdAt": "...",
  "status": "RUNNING",
  "peak": 1000, "trough": 1000,
  "positions": {
    "BTC/USD": { "side":"long", "size":0.001, "entry":65000, "stopPx":64000, "tpPx":67000,
                 "openedAt":"...", "entryOrderId":"...", "tpOrderId":null }
  },
  "tradeSeq": 0,
  "seenFills": [],
  "lastEquity": 1000
}
```

`trades.jsonl`: un registro por cierre con `seq, ts, symbol, side, entry, exit, size, gross, fees, net, reason`.

Regla de dedupe (lección del blackout): clave `symbol|openedAt`, no solo `seenFills`,
porque un ciclo puede morir entre append y persist. Verificar antes de append.

---

## 5. Ciclo de trading (`trader.mjs loop`)

Un ciclo hace dos fases, en este orden:

### 5.1 `manage()` — primero, siempre

Para cada posición abierta:
1. Leer precio actual (ticker).
2. Si `price <= stopPx` → cerrar market sell, registrar LOSS, cancelar TP resting.
3. Si `price >= tpPx` → cerrar market sell (o dejar que el limit TP se ejecute),
   registrar WIN.
4. `timeStop`: si `now - openedAt >= HOLD_MAX_DAYS` (5d) y no en profit → cerrar.
5. (Opcional) mover stop a break-even si `FBOT_PROTECT` activo — **off por defecto**.

También `sweepStale()`: cancelar limit sells resting de símbolos sin posición
(orphan take-profits).

### 5.2 `entry()`

1. Equity actual + verdict; si PASS/BUST → no nuevas entradas, solo manage.
2. `budgetFor(equity, state)` → riesgo permitido.
3. Universe (24 majors). Para cada candidato:
   - Señal: extensión ≥ `K×ATR14` del EMA20. En spot solo long: comprar cuando
     el precio está estirado **por debajo** del EMA (dip) — continuation down
     no aplica en spot (no se puede short). Alternativa: fade rips (short) no
     disponible. **Decisión de diseño pendiente de backtest.**
   - Filtro de correlación: skip si corr > 0.6 con algún held.
   - Ranking por `ext`.
4. Hasta `MAX_CONCURRENT` (4) posiciones. Colocar market buy, registrar estado
   inmediatamente después del fill (bug #6), luego colocar limit sell TP resting.

### 5.3 Protección pasiva (decisión: software stop + limit TP resting)

Spot no tiene stop orders. Decisión adoptada:

- **Stop: software** (evaluado por `manage()` cada ciclo, 45s). No se usa stop
  emulado con limit sell: un limit sell a precio stop solo se ejecuta si el
  mercado alcanza ese nivel y puede fallar en gaps o parcialmente. Riesgo
  residual documentado.
- **Take-profit: limit sell resting** a `tpPx`, colocado tras el fill. Reduce el
  daño de una caída del daemon al lado stop únicamente (el target queda
  protegido por el exchange).
- **Tamaño conservador** mientras no haya evidencia de edge: el riesgo residual
  de outage se acota por el sizing, no por órdenes.
- `sweepStale()` cancela limit TP de símbolos sin posición (orphan tras cierre
  por stop software).

Riesgo residual aceptado: una caída del daemon + gap de precio puede hacer que
el stop software se ejecute tarde o a peor precio. Mitigación: watchdog +
`kspot` self-healing + ciclo 45s + limit TP resting + tamaño conservador.

---

## 6. Estrategia — decisión abierta y deuda

El sistema futures usa **dual-trigger short** (ambas direcciones → short). En spot
no se puede short, así que la estrategia debe ser **long-only**. Opciones:

- A. Comprar dips (precio estirado por debajo del EMA) — mean reversion long.
- B. Breakout long (precio rompe máximo reciente).
- C. Reusar la lógica de extensión pero invertida (long cuando oversold).

**No hay backtest spot válido aún.** Antes de activar entradas, correr un sweep
sobre `hist.big.1d.json` (o descargar spot OHLC) con la estrategia candidata y
medir PASS rate / worst equity. El plan no fija parámetros; los deja como
constantes validadas por sweep, igual que futures (`K=1.2`, etc. solo tras
evidencia).

Recomendación: empezar con `MAX_CONCURRENT=2`, `K=1.5` (más selectivo) y
activar entradas solo tras un backtest que muestre ≥1 PASS en 6 bloques de 6
meses. Mientras tanto, el trader puede correr en modo `noentry` (solo manage)
para validar infraestructura sin riesgo.

---

## 7. Riesgo (`riskpolicy.mjs` adaptado)

- Fees 0.26% lado → `FEE = 0.0026`, round-trip 0.52%.
- `rrAfterFees(stopPct, targetPct)` con coste 0.52%.
- Ladder: reusar la curva piecewise (floor $970 → $0, knee $1045 → $7,
  target $1120 → $20) pero recalibrar porque el fee es 5× mayor: el stop
  efectivo debe ser mayor para que `rr` siga siendo ≥2 después de fees.
- Portfolio cap $75 sobre riesgo simultáneo (stop distance × size), contando
  posiciones abiertas.
- Sin apalancamiento → tamaño limitado solo por el floor.

Validar con `tests.mjs`: un loss nunca excede 20% del cushion en $975/$990/$1000/
$1050/$1119.

---

## 8. Runner (`runner.mjs`)

Copiar estructura del futures:
- `TICK_MS = 45_000`
- `CYCLE_TIMEOUT_MS = 300_000`
- Spawn `node trader.mjs loop` en child, capturar stdout/stderr
- Parsear última línea JSON del stdout
- Contar fallos consecutivos; halt a 8
- `snapshot()` guarded (lock retry) para equity/verdict
- PASS/BUST → break y log final
- Escribir `runner.state.json` cada ciclo

Diferencia: en spot, tras PASS/BUST, además `cancel-all` y opcionalmente
liquidar (spot no tiene flatten automático; cerrar todas las posiciones market).

---

## 9. Watchdog (`watchdog.sh`)

Copiar exactamente el patrón, adaptando cwd y comando:

```sh
#!/bin/sh
cd /home/oc/kraken-spot || exit 1
while true; do
  if ! pgrep -f "^node runner\.mjs" >/dev/null 2>&1; then
    echo "$(date -u +%FT%TZ) [WATCHDOG] runner down — restarting" >> watchdog.log
    setsid nohup node runner.mjs >/dev/null 2>>runner.err < /dev/null &
    sleep 3
  fi
  sleep 45
done
```

Lanzamiento: `setsid nohup sh watchdog.sh >/dev/null 2>>runner.err </dev/null &`

Reglas de proceso (de la experiencia futures):
- Anclar en argv completo (`/^\s*\d+\s+(?:[\w./-]*\/)?node runner\.mjs\s*$/`),
  no substring (evita falsos positivos de wrappers `bash -c`).
- Nunca matar por nombre con patrón amplio; matar por PID.
- `k1000`-equivalente (`kspot`) self-healing: si runner down, relanzar y
  verificar tras 6s; nunca revivir si ya PASS/BUST.

---

## 10. Validación (`validate.mjs`)

Checks mínimos (adaptar los 40 del futures):
1. Código parsea (`node --check`).
2. Constantes (`K`, `MAX_CONCURRENT`, `HOLD_MAX_DAYS`, `FEE`, leverage N/A).
3. Procesos: exactamente un runner y un watchdog (argv anclado).
4. Estado local vs exchange: posiciones, tamaños, lado.
5. Brackets: en spot no hay brackets; verificar en cambio que cada posición
   tiene un TP limit resting coherente (o ninguno si se gestiona por software).
6. Ledger: `equity = start + realized - fees + unrealized` (fees 0.26%).
7. Journal: seq únicos, net finito, side válido.
8. Verdict logic.
9. Signal scan: cuántos pares señalizan.

Lock discipline: reintentar hasta 12× con 5s si `in use by another process`.

---

## 11. Tests (`tests.mjs`)

Sin red, slicing por marcadores:
- ladder: un loss nunca >20% del cushion.
- analyse: oversold → long signal, overbought → no signal (spot), mid-range → none.
- geometry: stop en lado de pérdida, target en lado de ganancia, target > stop (2R),
  break-even dentro de fees.
- corrWith: bloqueo por correlación.
- constants.

Cubrir también `manage()` y `flatten()` con mocks (deuda del futures: no cubiertos).

---

## 12. Operación

```bash
cd /home/oc/kraken-spot
node ctl.mjs status            # scoreboard
node validate.mjs              # consistencia
node trader.mjs loop           # UN ciclo (nunca con runner vivo)
tail -f bot.log
```

- Runner cada 45s; velas de 1h cambian solo al cerrar barra.
- Parar limpio: esperar a que no haya child `trader.mjs`, luego matar runner
  por PID. `pkill -f "^node runner\.mjs"`.
- Reiniciar watchdog: `setsid nohup sh watchdog.sh >/dev/null 2>>runner.err </dev/null &`
- Reanudar tras reboot: `resume.sh` (relanza runner+watchdog, espera un ciclo real,
  corre validate + tests, no coloca órdenes).

---

## 13. Riesgos específicos de spot paper

1. **Sin stop en exchange**: una caída del daemon deja posiciones sin protección.
   Mitigación: watchdog + ciclo 45s + limit TP resting + kspot self-healing.
2. **Fees 5× mayores**: edge más delgado; validar con backtest antes de activar.
3. **Solo long**: en bear market el bot puede quedar inactivo o acumular pérdidas.
   Mitigación: estrategia y universe definidos por sweep, no por intuición.
4. **Workspace lock**: contención con status manuales; retries.
5. **Dedupe de cierres**: clave `symbol|openedAt`, no solo `seenFills`.
6. **Proceso match**: anclar en argv completo.

---

## 14. Lecciones heredadas aplicadas (futures → spot)

Tabla de mapeo (ver conversación para detalle):

| Lección futures | Aplica en spot | Adaptación |
|---|---|---|
| Lock contention | Sí | retries 8× en `kraken()` + `snapshot()` guarded |
| Registrar estado tras fill | Sí (crítico) | inmediatamente después del market buy |
| Dedupe `symbol\|openedAt` | Sí | antes de append a `trades.jsonl` |
| `sweepStale()` orphans | Sí | cancelar limit TP de símbolos sin posición |
| `flatten()` signo | Sí | cierre long = `sell`; nunca vender más de lo poseído |
| `protect()` fracción | Sí | tests de break-even |
| `node --check` + validate | Sí | tras cada edit |
| Watchdog argv anclado | Sí | `pgrep -f "^node runner\.mjs"` |
| Matar por PID | Sí | — |
| No ciclo manual con runner vivo | Sí | — |
| 8 fallos → halt + sentinel | Sí (mejorado) | sentinel desde el inicio |
| `resume.sh` sin órdenes | Sí | — |
| Health check se auto-repara (k1000) | Sí | crear `kspot` equivalente |
| `ohlc --since` ignorado | Sí | profundidad por intervalo |
| Mutation testing / coverage gap | Sí | cubrir `manage()` y `flatten()` desde el inicio |
| No tunear por intuición | Sí | backtest split-window antes de activar entradas |
| Protección por defecto: fees | Sí (cambiado) | break-even cubre fees (prioridad no perder) |
| `HOLD_MAX_DAYS=5`, 24 majors, 4 slots, corr 0.6 | Parcial | punto de partida, recalibrar por sweep spot |
| RISK_SCALE eliminado | Sí | riesgo como curva de política |
| Fees en `rrAfterFees` | Sí | 0.52% round-trip |
| Brackets protegen en outage | Parcial | solo TP resting; stop es software (riesgo residual) |
| Proot: uptime no fiable | Sí | watchdog basado en `pgrep` |
| Dual-trigger short | No | spot long-only; lección metodológica sí |

## 15. Secuencia de implementación propuesta

1. Crear workspace `spotbot` con capital 1000 (una sola vez).
2. Implementar `ctl.mjs` + `spot.mjs` + `state.json` loader. Probar `status`.
3. Implementar `trader.mjs` en modo `noentry` (solo manage) + tests de parsing.
4. Backtest de la estrategia candidata sobre OHLC spot; fijar constantes.
5. Implementar `entry()` + riskpolicy + tests.
6. Implementar `runner.mjs` + `watchdog.sh` + `validate.mjs`.
7. Correr `validate.mjs` y `tests.mjs` hasta verde.
8. Activar runner en modo `noentry` 24h para validar infraestructura.
9. Activar entradas.

---

## 16. Estado de implementación (2026-10-18)

Implementado y validado (18/18 checks):

- `ctl.mjs`, `spot.mjs`, `riskpolicy.mjs`, `trader.mjs` (manage + entry + dry-run +
  flatten terminal), `runner.mjs` (arg `noentry`), `watchdog.sh` (ENTRY_ENABLED-aware),
  `validate.mjs`, `tests.mjs` (13/13), `resume.sh`, `kspot`.
- Workspace `spotbot` creado con capital $1000.
- Runner corriendo en modo **auto** (watchdog activo), entradas activadas con filtro
  RSI<35 + vela verde. Protección break-even (fees) activa (prioridad: no perder).

Parámetros actuales: K=1.2, MAX_CONCURRENT=4, CORR_MAX=1.0 (sin guard en filtro),
HOLD_MAX_DAYS=5, PROTECT=fees. Filtro de entrada: RSI<35 + vela verde.

## 17. Resultados del backtest spot (2026-10-18)

Datos: 720 velas diarias (~2 años, 2024-10 → 2026-10), 24 majors, 4 bloques de 180 días.

| Estrategia | Variantes probadas | PASS | BUST | Mejor win% | Peor equity |
|---|---|---|---|---|---|
| dip | K 1.0/1.2/1.5, slots 2/4, corr 0.65/1.0, risk 1× | 0/4 | 0/4 | ~62% (K=1.2) | $980 |
| breakout | idem | 0/4 | 0/4 | ~49% (K=1.2) | $981 |
| dip (risk 2×/3×) | — | 0/4 | 3/4 / 4/4 | — | $963 |

Conclusiones:
- Ninguna variante alcanza +12% en ningún bloque. El edge en spot long-only con
  esta familia es inexistente o demasiado delgado para el target.
- Subir el riesgo no ayuda: bustea. El sizing conservador es el único que no
  toca el floor.
- El dip supera al breakout en win rate y en peor equity (consistente con la
  lección del futures: mean-reversion > momentum en este universo).
- Esto replica la conclusión honesta del futures: ~1 de 6 bloques llega al target
  *con shorts*. En spot solo-long, la tasa es 0/4 incluso en un mercado bull.

Backtest adicional (trailing stop, K=1.0–1.2, hold 10d, trail 1.0/1.5 ATR): dip y breakout
siguen en 0/4 PASS, peor equity ~$972 (cerca del floor). El trailing no convierte el
edge inexistente en progreso.

Filtros probados (dip, K=1.2, 4 slots, 2 años):
  base: win 44.4%, entries 288, worst $972
  RSI<35: win 42.9%, entries 240
  volumen>1.5×: win 43.5%, entries 138
  vela verde: win 46.3%, entries 164
  trend (EMA50 subiendo): win 35.5%, entries 31
  RSI+GREEN: win 47.8%, entries 138, worst $976  ← mejor win rate
  todo junto: 0 entradas

Mejor candidato por win rate: RSI+GREEN (47.8%), a costa de 52% menos entradas.
Sigue sin alcanzar +12% en 2 años. Prioridad del usuario (ganar y no perder, sin
límite de tiempo) favorece este filtro: mayor win rate y peor equity menos profunda.

Prueba de diversificación (universo ampliado a 36 pares líquidos, RSI+GREEN, 2 años
alineados): win 42.2% vs 49.7% de los 24 majors; final $971 vs $973; peor equity
$971 vs $971. Ampliar el universo empeora el win rate, replicando sweep17 del
futures. Decisión: mantener los 24 majors; la diversificación por símbolos no ayuda.

Decisión recomendada: **no activar entradas** con esta familia. Opciones:
1. Rediseñar con otra familia (trend-following con trailing stop, multi-timeframe).
2. Usar el sistema futures ya existente (`/home/oc/challenge`) para el target +12%.
3. Mantener spot en `noentry` como infraestructura validada y laboratorio.

## 18. Lo que NO está decidido (requiere input del operador)

- Estrategia long concreta (dip vs breakout) y sus parámetros.
- Si el target/floor deben ser los del challenge (+12%/-3%) o distintos.
- Si usar limit TP resting o todo por software.
- Universe exacto y correlaciones (reusar las 24 majors o subset).

Este plan deja esos puntos como deuda explícita para no fingir precisión donde
no hay evidencia.
