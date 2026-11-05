// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * custom_hud_gauges - draws RPM (a bar with its number), speed, boost and
 * intake air temperature on the head-up display, through the cluster-render
 * service's `hud` target, from the car's own values.
 *
 * One LT_State_Wide page:
 *   HUD gauges            the master switch. On: the car's values go to the HUD
 *                         (while the engine runs) whether or not this page is
 *                         shown, and the app stays active. Off: nothing is read
 *                         or drawn. Kept across restarts.
 *   Engine reads          boost and intake temperature, asked of the engine unit
 *                         with read-only requests. Off: only RPM and speed, which
 *                         the car sends on its own. Kept across restarts.
 *   Demo, Stop demo       90 s of made-up values, labelled DEMO.
 * and three status lines: the HUD, the source of each value, the renderer.
 *
 * vehicle_source.js has the car's values, hud_controller.js the HUD.
 */
'use strict';

const OnlineApp = require('oap-sdk/src/core/OnlineApp.js');
const logging = require('oap-sdk/src/logging/logging');
const path = require('path');
const { HudController } = require('./hud_controller.js');
const { VehicleSource } = require('./vehicle_source.js');
const { Settings } = require('./settings.js');

const logger = logging.getSDKLogger();

/* the app's data folder: oap_<uid>/data, beside source/ */
const DATA_DIR = path.join(__dirname, '..', '..', 'data');

const STATE_NAME = 'ST_OnlineApps_HudGauges';
const STATUS_NAME = 'hgStatus';
const SOURCE_NAME = 'hgSource';
const DETAIL_NAME = 'hgDetail';
const MASTER_NAME = 'hgMaster';
const ENGINE_NAME = 'hgEngine';
const START_NAME = 'hgStart';
const STOP_NAME = 'hgStop';
const NAMES = [STATUS_NAME, SOURCE_NAME, DETAIL_NAME, MASTER_NAME, ENGINE_NAME, START_NAME, STOP_NAME];
const STATUS_MS = 1000;
const PRESS_DEDUPE_MS = 400;
const HIDE_SETTLE_MS = 800;
const RENDER_MS = 500;
/* After a start by itself the gauges wait this long, so the head unit's own
 * start-up work is not competing with them. HUDG_RESUME_DELAY_MS is for tests. */
const RESUME_DELAY_MS = process.env.HUDG_RESUME_DELAY_MS !== undefined ?
    Number(process.env.HUDG_RESUME_DELAY_MS) : 15000;

class HudGaugesApp extends OnlineApp {
    constructor() {
        super();
        this._state = null;
        this._components = {};
        this._actionById = {};
        this._lastPress = {};
        this._written = {};
        this._visible = false;
        this._sawForeground = false;
        this._shutdownPromise = null;
        this._hideTimer = null;
        this._renderTimer = null;
        this._statusTimer = null;
        this._resumeTimer = null;
        this._notice = '';
        this._settings = new Settings(DATA_DIR, logger);
        this._hud = new HudController({ log: logger });
        this._hud.on('change', () => this._scheduleRender());
        this._source = new VehicleSource({
            log: logger,
            engine: this._settings.get('engine'),
            builders: sdkBuilders(),
            onSample: (sample) => this._hud.feed(sample)
        });

        this.on('initialized', () => {
            this._appInitialized()
                .catch((err) => logger.error(`custom_hud_gauges init failed: ${err && err.message}`));
        });
        this.on('shutdown', (reason) => this._handleShutdown(reason));
        this.on('error', (err) => logger.warn(`OnlineApp error: ${err && err.message}`));
        this.on('entryPointExecute', (uuid) => this._onEntryPointExecute(uuid));
        this.on('changeVisibility', (data) => {
            if (data && data.visible === false) {
                this._setVisible(false);
            }
        });
    }

    _appInitialized() {
        logger.info(`custom_hud_gauges ${this.getAppId()} v${this._packageJson.version} starting`);
        if (!this.rhmiApplication) {
            logger.info('no RhmiApplication for this start reason; initializing without a screen');
            return this.initialized();
        }
        const foregroundStart = this._startedForeground();
        return this._setupRhmi()
            .then(() => this._registerEntryPoints())
            .then(() => {
                if (foregroundStart || this._settings.get('hud')) {
                    this.registerActive();
                }
                return this.initialized();
            })
            .then(() => {
                /* the switch was left on: the gauges come back by themselves, unless
                 * the last starts did not survive (then they stay off until the
                 * driver turns them on) */
                if (this._settings.get('hud')) {
                    if (this._settings.beginAutoStart()) {
                        this._resumeTimer = setTimeout(() => {
                            this._resumeTimer = null;
                            if (this._settings.get('hud') && !this._shutdownPromise) {
                                this._applyMaster(true);
                            }
                        }, RESUME_DELAY_MS);
                    } else {
                        this._notice = 'Switched off: the app did not stay up on the last starts. Turn it on to try again.';
                        logger.warn('automatic start paused after repeated failed starts');
                    }
                }
                if (foregroundStart) {
                    this._sawForeground = true;
                    this._setVisible(true);
                }
                const lastUuid = this.getLastExecutedEntryPointUuid &&
                    this.getLastExecutedEntryPointUuid();
                return lastUuid ? this._onEntryPointExecute(lastUuid) : undefined;
            });
    }

    _startedForeground() {
        const FOREGROUND_REASONS = ['ENTRY_POINT', 'LUM', 'BOOKMARK',
            'START_WIDGET', 'TRIGGER_HMI', 'SPEECH_COMMAND'];
        const data = this.getVisibilityData && this.getVisibilityData();
        const reason = (data && data.reason) || this.startReason;
        return FOREGROUND_REASONS.includes(reason);
    }

    /* ---- RHMI ---- */
    _setupRhmi() {
        const rhmi = this.rhmiApplication;
        this._state = rhmi.getByName(STATE_NAME);
        if (!this._state) {
            return Promise.reject(new Error(`uiDescription has no ${STATE_NAME}`));
        }
        NAMES.forEach((name) => { this._components[name] = rhmi.getByName(name); });
        const missing = NAMES.filter((name) => !this._components[name]);
        if (missing.length) {
            return Promise.reject(new Error(`uiDescription lacks ${missing.join(', ')}`));
        }
        this._bind(MASTER_NAME, () => this._toggle(MASTER_NAME, 'hud', (on) => this._applyMaster(on)));
        this._bind(ENGINE_NAME, () => this._toggle(ENGINE_NAME, 'engine', (on) => this._source.setEngine(on)));
        this._bind(START_NAME, () => this._hud.startDemo());
        this._bind(STOP_NAME, () => this._hud.stopDemo());
        rhmi.on('userEvent', (ev) => {
            const entry = ev && ev.eventType === 'ACTION' && this._actionById[Number(ev.sourceId)];
            if (entry) {
                this._press(entry.name, entry.handler);
            }
        });
        rhmi.on('applicationStackChanged', (stack) => {
            const keys = stack && typeof stack === 'object' ? Object.keys(stack) : [];
            if (!keys.length) {
                return;
            }
            if (Object.prototype.hasOwnProperty.call(stack, 'ROOT_APP')) {
                this._sawForeground = true;
                this._setVisible(true);
            } else if (this._sawForeground) {
                this._setVisible(false);
            }
        });
        rhmi.on('restoreHmi', () => {
            logger.info('RESTORE_HMI: re-pushing page content');
            this._written = {};
            this._render();
        });
        this._state.on('visible', (event) => this._pageVisible(isTrue(event && event.visible)));
        return this._state.updateResources().then(() => {
            logger.info(`page ready: ${NAMES.length} components found`);
            this._render();
        });
    }

    _bind(name, handler) {
        const comp = this._components[name];
        let id = null;
        try {
            id = comp.getId();
        } catch (e) {
            id = null;
        }
        if (id !== null) {
            this._actionById[Number(id)] = { name, handler };
        }
        logger.info(`BIND OK: ${name} (id ${id})`);
        comp.on('action', () => this._press(name, handler));
    }

    /* A press arrives as the component's 'action' and as the raw 'userEvent';
     * both land here, and one delivered twice counts once. */
    _press(name, handler) {
        const now = Date.now();
        if (now - (this._lastPress[name] || 0) < PRESS_DEDUPE_MS) {
            return;
        }
        this._lastPress[name] = now;
        logger.info(`BUTTON ACTION ${name}`);
        try {
            handler();
        } catch (err) {
            logger.warn(`${name} failed: ${err && err.message}`);
        }
    }

    _registerEntryPoints() {
        const descriptions = (this.appDescription &&
            this.appDescription.application.entryPoints) || [];
        const ours = this.getEntryPoints().find(
            (ep) => descriptions.some((d) => d.uuid === ep.getDescription().uuid));
        if (!ours) {
            return Promise.reject(new Error('no entry point handed over by the manager'));
        }
        const description = ours.getDescription();
        return ours.init()
            .then(() => this.rhmiApplication.mapEntryState(description.uuid, this._state))
            .then(() => Promise.resolve()
                .then(() => ours.entryPoint.setText(description.textId))
                .then(() => (description.icon ? ours.entryPoint.setIcon(description.icon) : undefined))
                .catch((err) => logger.warn(`entry point text/icon: ${err && err.message}`)))
            .then(() => ours.setAvailability('ENABLED'))
            .then(() => logger.info(`entry point ${description.name} ENABLED`));
    }

    _onEntryPointExecute(uuid) {
        if (this._shutdownPromise || !this.rhmiApplication || !uuid) {
            return Promise.resolve();
        }
        this._sawForeground = true;
        this._setVisible(true);
        return Promise.resolve(this.rhmiApplication.openEntryState(uuid))
            .catch((err) => logger.warn(`openEntryState failed: ${err && err.message}`));
    }

    /* ---- visibility ---- */
    _pageVisible(visible) {
        if (this._shutdownPromise) {
            return;
        }
        clearTimeout(this._hideTimer);
        this._hideTimer = null;
        if (visible) {
            this._sawForeground = true;
            this._setVisible(true);
        } else {
            this._hideTimer = setTimeout(() => {
                this._hideTimer = null;
                this._setVisible(false);
            }, HIDE_SETTLE_MS);
        }
    }

    _setVisible(visible) {
        if (this._shutdownPromise || this._visible === visible) {
            return;
        }
        this._visible = visible;
        logger.info(`page ${visible ? 'visible' : 'hidden'}`);
        this._reportVisibilityStatus(visible);
        if (visible) {
            this._hud.open();
            this._startStatusTimer();
        } else {
            clearInterval(this._statusTimer);
            this._statusTimer = null;
            /* With the switch on the gauges go on without the page. Otherwise
             * closing the connection removes the HUD layers. */
            if (!this._settings.get('hud')) {
                this._hud.stop();
                this._hud.close();
            }
        }
        this._render();
    }

    _startStatusTimer() {
        if (!this._statusTimer) {
            this._statusTimer = setInterval(() => this._render(), STATUS_MS);
        }
    }

    /* ---- the switches ---- */
    _toggle(name, key, apply) {
        const on = !this._settings.get(key);
        this._notice = '';
        clearTimeout(this._resumeTimer);
        this._resumeTimer = null;
        this._settings.set(key, on);
        apply(on);
        /* the HMI ticks the box itself; ours decides what it shows */
        delete this._written[`selected:${name}`];
        this._render();
    }

    _applyMaster(on) {
        if (on) {
            this._hud.open();
            this._source.start();
            if (this._initialized) {
                Promise.resolve(this.registerActive()).catch((err) =>
                    logger.warn(`registerActive failed: ${err && err.message}`));
            }
        } else {
            this._source.stop();
            this._hud.stop();
            if (!this._visible) {
                this._hud.close();
            }
        }
    }

    _reportVisibilityStatus(visible) {
        if (!this._initialized || !this._appStatusService) {
            return;
        }
        /* with the gauges on the app stays active when its page goes */
        const keep = this._settings.get('hud');
        const reports = visible ?
            [this.registerActive(), this.registerHmiVisible()] :
            [this.unregisterHmiVisible(), keep ? this.registerActive() : this.registerInactive()];
        reports.forEach((report) => Promise.resolve(report).catch((err) =>
            logger.warn(`app status report failed: ${err && err.message}`)));
    }

    /* ---- rendering ---- */
    _scheduleRender() {
        if (!this._renderTimer) {
            this._renderTimer = setTimeout(() => {
                this._renderTimer = null;
                this._render();
            }, RENDER_MS);
        }
    }

    _write(name, text) {
        if (this._written[name] !== text) {
            this._written[name] = text;
            Promise.resolve(this._components[name].setValue(0, 'Text', text, 'Text'))
                .catch((err) => logger.warn(`${name} render failed: ${err && err.message}`));
        }
    }

    _setEnabled(name, enabled) {
        const key = `enabled:${name}`;
        if (this._written[key] !== enabled) {
            this._written[key] = enabled;
            Promise.resolve(this._components[name].setEnabled(enabled))
                .catch((err) => logger.warn(`${name} enable failed: ${err && err.message}`));
        }
    }

    _setSelected(name, selected) {
        const key = `selected:${name}`;
        if (this._written[key] !== selected) {
            this._written[key] = selected;
            Promise.resolve(this._components[name].setValue(0, 'eParam_RowSelected', selected, 'Bool'))
                .catch((err) => logger.warn(`${name} select failed: ${err && err.message}`));
        }
    }

    _statusLine() {
        const hud = this._hud;
        if (!this._settings.get('hud') && this._notice && hud.mode !== 'demo') {
            return this._notice;
        }
        if (!hud.connected || hud.unsupported || hud.mode === 'demo') {
            return hud.statusText();
        }
        if (!this._settings.get('hud')) {
            return this._notice || 'HUD gauges are off';
        }
        return hud.mode === 'live' ? hud.statusText() : 'On. Waiting for the car (engine running?)';
    }

    _render() {
        if (!this._state || this._shutdownPromise) {
            return;
        }
        this._write(STATUS_NAME, this._statusLine());
        this._write(SOURCE_NAME, this._source.problem() || this._source.text());
        const notes = this._source.notes();
        this._write(DETAIL_NAME, notes ? `${this._hud.detailText()}. Engine: ${notes}` : this._hud.detailText());
        this._setSelected(MASTER_NAME, this._settings.get('hud'));
        this._setSelected(ENGINE_NAME, this._settings.get('engine'));
        this._setEnabled(START_NAME, this._hud.canStart());
        this._setEnabled(STOP_NAME, this._hud.mode === 'demo');
    }

    /* ---- shutdown ---- */
    _handleShutdown(reason) {
        if (this._shutdownPromise) {
            return this._shutdownPromise;
        }
        logger.info(`custom_hud_gauges shutdown: ${JSON.stringify(reason)}`);
        clearTimeout(this._renderTimer);
        clearTimeout(this._hideTimer);
        clearInterval(this._statusTimer);
        clearTimeout(this._resumeTimer);
        this._settings.markStable();   /* a clean stop is not a crash */
        this._source.stop();
        this._hud.stop();
        this._hud.close();
        this._shutdownPromise = Promise.resolve()
            .then(() => this.destroyBundles().catch((err) =>
                logger.info(`destroyBundles: ${err && err.message}`)))
            .then(() => process.exit(0));
        return this._shutdownPromise;
    }
}

/* The SDK's own SOME/IP builders: the fallback for the car's signals where the
 * native module cannot be reached. */
function sdkBuilders() {
    try {
        return require('oap-sdk/src/someip/someipBuilders');
    } catch (e) {
        return null;
    }
}

/* RHMI event values arrive as booleans, or as 1/0 on some HMIs. */
function isTrue(raw) {
    return raw === true || raw === 'true' || raw === 1 || raw === '1';
}

const app = new HudGaugesApp();

/* Fail safe: an error nobody handled switches the gauges off for good (until
 * the driver turns them on again), lets go of the HUD and the car's signals,
 * and exits, so a fault cannot turn into a restart loop that keeps drawing or
 * asking. An unhandled rejection is only logged: the SDK has its own. */
process.on('uncaughtException', (err) => {
    try {
        logger.error(`custom_hud_gauges: uncaught ${err && err.stack || err}; gauges switched off`);
        app._settings.set('hud', false);
        app._source.stop();
        app._hud.stop();
        app._hud.close();
    } catch (e) {
        /* going down anyway */
    }
    setTimeout(() => process.exit(1), 200);
});
process.on('unhandledRejection', (err) => {
    logger.warn(`custom_hud_gauges: unhandled rejection ${err && err.message || err}`);
});
app.start().catch((err) => {
    /* Stays resident so the manager can stop or restart it. */
    logger.error(`custom_hud_gauges failed to start: ${err && err.message}`);
});
