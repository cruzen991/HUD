# HUD gauges (iDrive 7)

A head-up-display layout for a BMW with an iDrive 7 head unit, built for the
[mgu Store](https://github.com/robertnisipeanu/mgu-store) and drawn through
[cluster-render](https://github.com/robertnisipeanu/idrive-apps/tree/main/native/cluster-render)'s
`hud` target, **from the car's own values**, with switches in the car to turn it
on and off.

```
 ▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌    RPM bar: cyan, amber from 5000, red from 6200
 0     1     2     3     4     5     6     7
                                    RPM 6420   its number as well
                74 MPH                          speed, seven-segment digits
 BOOST                  IAT
 21.4 PSI               118 °F                  boost has a bar centred on 0 psi (blue = vacuum)
```

## Read this first

- **It has not been run on a car.** Everything is tested on a desk against fakes
  (`apps/custom_hud_gauges/tools/test_*.js`). The parts that only a car can confirm
  are listed under [What the first drive has to show](#what-the-first-drive-has-to-show).
  Try it **parked, engine running**, before you trust it on the road.
- **It needs a HUD**, and cluster-render lists the iDrive 7 `hud` target as unverified
  (its 800x480 size is flagged as a guess; it shares a scene id with `panel`; a wrong
  mapping can make the cluster and HUD restart).
- It is for **iDrive 7 only**, on a unit that is already rooted with the Store installed.
- **It only reads.** Nothing here writes to the car, codes it, clears faults or changes
  a control unit's session (see [How it reads](#how-it-reads)).
- The HUD is a distraction. Look at it like any other display, and not at all when it
  would take your eyes off the road for longer than you would take them for a mirror.

## In the car

Open **HUD gauges** from the apps list:

| | |
|---|---|
| **HUD gauges on** | The master switch, **off until you turn it on**. On: RPM and speed go to the HUD whenever the car sends them, **whether or not this page is shown**, and the app keeps itself active. Off: nothing is read, nothing is drawn. Kept across restarts (15 s after the app starts the gauges come back by themselves, see the crash guard below). |
| **Read boost and intake temp from the engine** | **Off until you turn it on**, a separate step so you can run RPM and speed alone first. Off: no request to any control unit at all. On: adds boost and intake temperature. Kept across restarts. |
| **Demo (90 s)** / **Stop demo** | Made-up values, labelled DEMO on the HUD. Reads nothing from the car. |
| three status lines | the HUD, each value (`RPM ok  Speed ok  Boost ok  Intake ok`, `-` for one that is not arriving), and the renderer, with what the engine unit last answered for boost and intake. |

With the switch on and the engine off (or the car asleep) nothing arrives and the HUD
hides itself, so the stock HUD is back. A value that stops arriving shows dashes, never
the last reading.

## Safety: what can and cannot go wrong

Nobody can promise "zero risk" on a car they have not tested against, so here is what is
guaranteed by construction and what is only likely.

**By construction (checked by the desk tests)**

- **No firmware or flash access.** The app's code has no flashing, coding or system-file
  access: it opens a socket to the cluster renderer, listens to two car signals, sends the
  read requests above, and writes one small file (`hud-gauges.json`) in its own data folder.
  It does not modify the system or any update path, so it cannot "brick" the unit the way a bad
  flash can. (It runs with whatever rights apps have on your rooted unit; that is the platform's
  doing, not something it uses.) Uninstalling in the Store removes it.
- **Read-only to the car.** Only `0x22` and OBD `0x01` reads to the engine unit are possible
  (the check is in front of the transport; everything else is refused before sending).
- **Starts off.** Both switches are off after install. Nothing is drawn or asked until you turn
  them on, and the engine reads are a second switch after that.
- **Fail-safe.** An unexpected error switches the gauges off (saved), lets go of the HUD and
  the car's signals and exits, so it cannot loop. If the automatic start does not get 30 s
  of running three times in a row, it switches the gauges off until you turn them on.
- **15 s after the app starts,** before it draws anything or asks the car for anything, so it
  does not compete with the unit's own start-up.
- **The HUD:** it only ever draws five layers on the `hud` target, hidden when the car sends
  nothing, removed when the app exits (the renderer drops a client's layers when its socket
  closes). Nothing is drawn on the cluster or the centre display.
- **Instant off:** the switch on the page, or uninstall in the Store. If the page is somehow
  unreachable, uninstalling removes the app, and the data folder's `hud-gauges.json` (set
  `"hud": false`) is the only state.

**Likely but unproven (needs your first drive)**

- The `hud` target's size and scene id are marked unverified in cluster-render. If the layout
  is placed wrongly you will see it in the Demo; switch off and tell me.
- The diagnostic transport is shared. A read-only request every 250 ms is light, but I have not
  seen it on a car. That is why it is a separate switch.

## Where the values come from

| Value | Source | Asks the car? |
|---|---|---|
| Engine speed | SOME/IP `CDS.statusEngineSpeed2`, raw × 0.25 rpm | no, the car sends it |
| Speed | SOME/IP `Vehicle2.statusCarSpeed2`, raw × 0.015625 km/h | no |
| Boost | engine unit (DME, address 0x12): UDS `22 4205 4201`, charge pressure less ambient pressure; if refused, OBD-II `01 0B` less `01 33` | yes, one read request 4 times a second |
| Intake air temp | UDS `22 580F` (× 0.75 − 48 °C); if refused, OBD-II `01 0F` | yes, one request every 2 s |

Scalings and identifiers are those the community
[idrive7-apps](https://github.com/cauliflowermossgrape/idrive7-apps) (`live_data`, `kit/runtime`)
applies for the B58 / B48 / B38 DME on cars (MIT); the way into the head unit's
diagnostic transport (TASU) is documented in its `kit/runtime/diag.js`. Boostline's
[iDrive 7 port](https://github.com/clucraft/boostline-idrive) reads the DME the same way.
Credit to both.

Boost is shown as pressure above ambient: negative (vacuum) at idle and cruise, positive
under boost. Implausible readings (a pressure outside 300-4000 hPa, a temperature outside
-45...130 °C) are dropped, not shown.

## How it reads

Every request passes `check()` in `src/tasu_link.js` before it can reach the transport:

- allowed: `0x22` ReadDataByIdentifier (1-8 identifiers) and `0x01` OBD-II current data
  (one PID), each to one control unit (the app only ever uses the engine unit, 0x12);
- refused with an error, before anything is sent: sessions (`10`), resets (`11`), clearing
  faults (`14`), security access (`27`), dynamic identifiers (`2C`), writes (`2E`), I/O control
  (`2F`), routines (`31`), tester present (`3E`), every other service, and any request to
  all units (`0xDF`).
- one request at a time, at least 25 ms apart; a busy answer from the transport is retried
  at once and the unit's own "busy" answer gives it a second; a unit that does not answer
  5 times in a row is skipped until it is woken again.

`tools/test_source.js` checks this against a fake transport (nothing but `22` and `01`
reaches it).

The head unit's diagnostic transport is shared with BMW's own services and other apps.
The app waits its turn, but it does add requests: if you see anything odd (warnings,
the HUD or cluster restarting, other apps slow), turn **Read boost and intake temp**
off and tell me what you saw.

## Install

1. Push this repository to your GitHub (it must be a repository the Store can read; if it
   is private the Store needs your token).
2. In the Store add **two** GitHub sources: this repository (on its branch, as a repo tree)
   and `robertnisipeanu/idrive-apps`, which provides `cluster-render`.
3. Install **HUD gauges**. The Store installs `cluster-render` first (0.3.7 or later is
   required) and builds the app on the head unit from source.
4. Open **HUD gauges**, press **Demo (90 s)** first: that tells you whether the HUD target
   works at all, with no car data involved. Then switch **HUD gauges on** with the engine
   running, and only then **Read boost and intake temp**.

## What the first drive has to show

Things the desk tests cannot answer, in the order you will meet them:

0. **Both switches are off.** Try in this order, parked, each step only after the last looked right: Demo, then **HUD gauges on** (RPM and speed), then **Read boost and intake temp**.
1. **The app installs.** Its manifest names SOME/IP interfaces (`vehicle.CDS`,
   `vehicle.Vehicle2` and the diagnostic `InternalTasu`); the unit refuses an app that
   names one its firmware lacks. If the install fails with `IFConfigGenerator ... not found`,
   the interface named there is missing on your firmware: tell me which.
2. **The HUD target.** The Demo shows whether the HUD draws at all and at what size.
3. **The car's signals.** With the switch on and the engine running, `RPM ok  Speed ok`.
   If they stay `-`, the app could not reach SOME/IP (the line then says why).
4. **The engine unit.** `Boost ok  Intake ok`. If not, the detail line shows the last answer,
   for example `boost refused (out of range)`; the app falls back to the OBD-II PIDs by
   itself after two refusals and tries the identifiers again after a minute.
5. **Staying alive.** With the switch on the app keeps reporting itself active so the app
   manager should not stop it when the page is closed. Whether it does, and whether the app
   is started again after a head-unit restart without opening it once, is unverified: if the
   gauges are gone after a restart, open **HUD gauges** once.

## Units and look

Defaults are mph, psi and °F. Change `DEFAULTS.units` in `src/hud_controller.js`
(`speed`: `mph`/`kmh`, `boost`: `psi`/`bar`/`kpa`, `temp`: `F`/`C`); thresholds and sizes
are `DEFAULTS` in `src/hud_render.js` (`rpmMax`, `rpmAmber`, `rpmRed`, ...). The Store builds
from source, so editing a fork is all that is needed.

## What is here

| | |
|---|---|
| `mgu-repo.json` | the Store entry (`requires` cluster-render) |
| `apps/custom_hud_gauges/mgu-app.json` | the source package: modules and staged tree. The head unit links it against its own oap-sdk; no BMW code is in this repository |
| `custom_hud_gauges@0.2.0/` | the staged tree: package, `manifest.json` (the SOME/IP interfaces), the page |
| `src/custom_hud_gauges.js` | the OnlineApp and its page |
| `src/vehicle_source.js` | the car's values, the switches' effect |
| `src/engine_reader.js`, `src/tasu_link.js` | the reads and the read-only check |
| `src/someip_native.js` | SOME/IP through the unit's `someip` module |
| `src/hud_controller.js` | the connection to cluster-render, units, staleness |
| `src/hud_render.js`, `src/hud_font.js`, `src/hud_demo.js` | the pictures (RGBA layers, changed rectangles only) and the demo |
| `src/cluster_render_client.js` | cluster-render's Node 8 client, MPL-2.0, unchanged |
| `tools/` | tests, fakes, `preview.js` (PNG previews of the layout) |

## Tests

```sh
sh apps/custom_hud_gauges/tools/test_all.sh
node apps/custom_hud_gauges/tools/preview.js out 800x480
```

The tests cover the package (manifest, staged tree, what each module requires, nothing newer
than Node 8's syntax), the pictures, the controller against a fake cluster-render socket,
the car's values against a fake SOME/IP module and engine unit (scalings, both routes, the
read-only check, busy and pending replies, the switches) and the page against a fake SDK.

## License

GPL-3.0-or-later ([`LICENSE`](LICENSE)). `cluster_render_client.js` is MPL-2.0
([`LICENSES/MPL-2.0.txt`](LICENSES/MPL-2.0.txt)). The scaling constants, identifiers and the
transport frame layout come from MIT-licensed projects named above. The page scaffold
(`manifest.json`, `permissions.json`) follows the Waze-on-cluster app of
[idrive-apps](https://github.com/robertnisipeanu/idrive-apps).
