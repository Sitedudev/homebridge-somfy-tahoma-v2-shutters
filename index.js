let Service, Characteristic;
const https = require('https');

const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m"
};

module.exports = (homebridge) => {
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;

  homebridge.registerPlatform(
    "homebridge-somfy-tahoma-v2-shutter",
    "TahomaShutters",
    SomfyShutterPlatform,
    true
  );
};

class SomfyShutterPlatform {
  constructor(log, config = {}, api) {
    this.log = log;
    this.config = config;
    this.api = api;
    this.accessoriesList = [];
    this.currentExecutions = {}; // map deviceURL -> execId
    this.lastPositions = {};     // map deviceURL -> last known position
    this.stableCounters = {}; // deviceURL -> compteur

    if (!this.config.ip || !this.config.token) {
      this.log.error("[TahomaShutter] Merci de remplir l'adresse IP (ip) et le token (token) dans la config.");
      return;
    }

    // Valeurs par défaut
    if (typeof this.config.pollingInterval === 'undefined') this.config.pollingInterval = 10;
    if (typeof this.config.logState === 'undefined') this.config.logState = true;
    if (typeof this.config.logInterval === 'undefined') this.config.logInterval = 30;
    if (!this.config.namePrefix) this.config.namePrefix = "Volet";

    // Exclusions configurables dans config (deviceURL exact ou label)
    this.excludeDeviceURLs = (this.config.filters && this.config.filters.excludeDeviceURLs) || [];
    this.excludeLabels = (this.config.filters && this.config.filters.excludeLabels) || [];

    if (api) {
      this.api.on('didFinishLaunching', this.onDidFinishLaunching.bind(this));
      this.api.on('shutdown', () => this.clearTimers());
      this.api.on('unload', () => this.clearTimers());
    }
  }

  clearTimers() {
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = null;
      this.log.info("[TahomaShutter] Timer de polling arrêté.");
    }
    if (this.logTimer) {
      clearInterval(this.logTimer);
      this.logTimer = null;
      this.log.info("[TahomaShutter] Timer de logs arrêté.");
    }
  }

  configureAccessory(accessory) {
    // Accessoires sauvegardés par Homebridge (cache)
    this.accessoriesList.push(accessory);
    // On laisse le nettoyage des timers à l'init
    this.clearTimers();
  }

  async onDidFinishLaunching() {
    this.log("[TahomaShutter] Initialisation du plugin Tahoma Volets (détection automatique) ...");

    try {
      const devices = await this.callTahomAPI("getDevices");
      if (!Array.isArray(devices)) {
        this.log.error("[TahomaShutter] getDevices n'a pas renvoyé de liste.");
        return;
      }

      // Liste d'exclusion par défaut (on exclut ce qui n'est clairement pas un volet)
      const defaultExclude = ["garage", "gate", "portail", "awning", "light", "switch", "remote", "sensor", "alarm", "plug", "heating", "thermostat"];
      const excludeKeywords = (this.config.filters && this.config.filters.excludeKeywords) || defaultExclude;

      // Détection : on considère comme "mouvement ouvrant/ferm" tout device contenant ces mots
      const movementKeywords = ["roller", "shutter", "blind", "curtain", "volet"];

      // Filtre initial : on garde uniquement devices qui semblent bouger et qui ne sont pas explicitement exclus
      const candidates = devices.filter(d => {
        const widget = (d.definition && d.definition.widgetName) ? d.definition.widgetName.toLowerCase() : "";
        const label = (d.definition && d.definition.label) ? d.definition.label.toLowerCase() : (d.label ? d.label.toLowerCase() : "");
        // Exclusions explicites configurées
        if (this.excludeDeviceURLs.includes(d.deviceURL)) return false;
        if (this.excludeLabels.some(ex => ex && label.includes(ex.toLowerCase()))) return false;
        // Exclusion par mot-clé
        if (excludeKeywords.some(k => widget.includes(k) || label.includes(k))) return false;
        // Au moins un mot de mouvement présent
        return movementKeywords.some(k => widget.includes(k) || label.includes(k));
      });

      // Log debug : liste des widgets/labels détectés (utile pour peaufiner)
      if (this.config.debugMode) {
        this.log.info("[TahomaShutter] Widgets détectés (debug) :");
        devices.forEach(d => {
          this.log.info(`  - ${d.deviceURL} | widget: ${d.definition?.widgetName} | label: ${d.definition?.label || d.label}`);
        });
      }

      // Register/create un accessoire par volet candidat
      for (const device of candidates) {
        await this.registerOrUpdateAccessory(device);
      }

      // Supprimer les accessoires orphelins (cache) qui ne sont plus présents ou sont maintenant exclus
      await this.purgeOrphanAccessories(devices, candidates);

      // Démarrer polling si on a au moins 1 accessoire
      if (this.accessoriesList.length > 0) {
        this.startPolling();
      } else {
        this.log.info("[TahomaShutter] Aucun accessoire Volet créé (vérifie tes filtres/exclusions).");
      }

      // Logs périodiques optionnels
      if (this.config.logState !== false) {
        let interval = this.config.logInterval || 30;
        if (interval < 5) interval = 5;
        if (interval > 300) interval = 300;
        this.log.info(`[TahomaShutter] Logs d’état activés toutes les ${interval}s`);
        this.logTimer = setInterval(async () => {
          await this.logAllStates();
        }, interval * 1000);
      }

    } catch (err) {
      this.log.error("[TahomaShutter] Erreur lors de l'initialisation:", err.message || err);
    }
  }

  // Crée ou met à jour un accessoire pour un device donné
  async registerOrUpdateAccessory(device) {
    const uuid = this.api.hap.uuid.generate(device.deviceURL);
    let accessory = this.accessoriesList.find(a => a.UUID === uuid);
  
    // 🏷️ Nom d’origine du volet
    const rawName = device.label || device.definition?.label || device.definition?.widgetName || null;
    const displayName = rawName ? rawName.trim() : `${this.config.namePrefix} ${this.accessoriesList.length + 1}`;
  
    if (!accessory) {
      accessory = new this.api.platformAccessory(displayName, uuid);
      accessory.__deviceURL = device.deviceURL;
      this.accessoriesList.push(accessory);
      this.api.registerPlatformAccessories("homebridge-somfy-tahoma-v2-shutter", "TahomaShutter", [accessory]);
      this.log.info(`[TahomaShutter] 🆕 Accessoire créé: ${displayName} (${device.deviceURL})`);
    } else {
      // Si l'accessoire existe déjà, on met à jour son nom si nécessaire
      if (accessory.displayName !== displayName) {
        this.log.info(`[TahomaShutter] 🔄 Mise à jour nom: ${accessory.displayName} → ${displayName}`);
        accessory.displayName = displayName;
      }
      accessory.__deviceURL = device.deviceURL;
    }
  
    // --- Informations Accessory ---
    accessory
      .getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, "Somfy/Tahoma")
      .setCharacteristic(Characteristic.Model, device.definition?.widgetName || "RollerShutter")
      .setCharacteristic(Characteristic.SerialNumber, device.deviceURL);
  
    // --- Service WindowCovering ---
    const coverService =
      accessory.getService(Service.WindowCovering) ||
      accessory.addService(Service.WindowCovering, displayName);
  
    // --- CurrentPosition ---
    coverService.getCharacteristic(Characteristic.CurrentPosition).onGet(() => {
      const pos = this.lastPositions[device.deviceURL];
      return typeof pos === "number" ? pos : 0;
    });
  
    // --- TargetPosition ---
    coverService.getCharacteristic(Characteristic.TargetPosition)
    .onSet(async (value) => {
      try {
        // Met à jour HomeKit uniquement TargetPosition
        coverService.updateCharacteristic(Characteristic.TargetPosition, value);
    
        // Envoi commande au volet
        const exec = await this.sendSetPosition(device.deviceURL, value);
        if (exec) {
          this.currentExecutions[device.deviceURL] = exec;
          this.log.info(`[TahomaShutter] Commande Position ${value}% envoyée à ${device.deviceURL} (execId: ${exec})`);
        }
    
        // On ne touche pas CurrentPosition ici : le polling s'en charge
      } catch (err) {
        this.log.error("[TahomaShutter] Erreur envoi TargetPosition:", err);
      }
    });


  
    // --- PositionState ---
    coverService
      .getCharacteristic(Characteristic.PositionState)
      .onGet(async () => Characteristic.PositionState.STOPPED);
  
    // --- Stockage utile pour polling ---
    accessory.__coverService = coverService;
    accessory.__hasPosition = true;
    this.lastPositions[device.deviceURL] = this.lastPositions[device.deviceURL] || 0;
  }


  // Supprime les accessoires en cache qui ne correspondent plus à des devices détectés ou qui sont explicitement exclus
  async purgeOrphanAccessories(allDevices, candidateDevices) {
    const candidateDeviceURLs = candidateDevices.map(d => d.deviceURL);
    const allDeviceURLs = (allDevices || []).map(d => d.deviceURL);

    const toRemove = [];
    for (const acc of this.accessoriesList) {
      const devURL = acc.__deviceURL || null;
      // Si l'accessoire n'a pas de deviceURL ou si le deviceURL n'est plus présent dans allDevices => suppression
      if (!devURL || !allDeviceURLs.includes(devURL) || !candidateDeviceURLs.includes(devURL)) {
        toRemove.push(acc);
      }
    }

    if (toRemove.length > 0) {
      this.api.unregisterPlatformAccessories("homebridge-somfy-tahoma-v2-shutter", "TahomaShutter", toRemove);
      toRemove.forEach(r => this.log.info(`[TahomaShutter] Accessoire supprimé: ${r.displayName}`));
      // Mise à jour du cache local
      this.accessoriesList = this.accessoriesList.filter(a => !toRemove.includes(a));
    }
  }

  startPolling() {
    const interval = (this.config.pollingInterval || 10) * 1000;
    if (this.pollingTimer) clearInterval(this.pollingTimer);
  
    this.pollingTimer = setInterval(async () => {
      try {
        const devices = await this.callTahomAPI("getDevices");
  
        for (const accessory of this.accessoriesList) {
          const deviceURL = accessory.__deviceURL;
          if (!deviceURL) continue;
  
          const device = devices.find(d => d.deviceURL === deviceURL);
          if (!device) continue;
  
          const coverService = accessory.__coverService;
          if (!coverService) continue;
  
          const state = await this.getShutterState(deviceURL);
          const currentPos = state.currentPosition;
  
          const lastPos = this.lastPositions[deviceURL];
          if (this.stableCounters[deviceURL] == null) {
            this.stableCounters[deviceURL] = 0;
          }
  
          // ---------- 1️⃣ PREMIER PASSAGE ----------
          if (lastPos == null) {
            coverService.updateCharacteristic(
              Characteristic.CurrentPosition,
              currentPos
            );
            coverService.updateCharacteristic(
              Characteristic.PositionState,
              Characteristic.PositionState.STOPPED
            );
            coverService.updateCharacteristic(
              Characteristic.TargetPosition,
              currentPos
            );
  
            this.lastPositions[deviceURL] = currentPos;
            continue;
          }
  
          // ---------- 2️⃣ POSITION EN MOUVEMENT ----------
          if (currentPos !== lastPos) {
            coverService.updateCharacteristic(
              Characteristic.CurrentPosition,
              currentPos
            );
  
            const posState =
              currentPos > lastPos
                ? Characteristic.PositionState.INCREASING
                : Characteristic.PositionState.DECREASING;
  
            coverService.updateCharacteristic(
              Characteristic.PositionState,
              posState
            );
  
            this.stableCounters[deviceURL] = 0;
            this.lastPositions[deviceURL] = currentPos;
            continue;
          }
  
          // ---------- 3️⃣ POSITION STABLE ----------
          this.stableCounters[deviceURL]++;
  
          if (this.stableCounters[deviceURL] >= 2) {
            coverService.updateCharacteristic(
              Characteristic.PositionState,
              Characteristic.PositionState.STOPPED
            );
  
            coverService.updateCharacteristic(
              Characteristic.TargetPosition,
              currentPos
            );
          }
        }
      } catch (err) {
        this.log.error(
          "[TahomaShutter] Erreur polling:",
          err.message || err
        );
      }
    }, interval);
  
    this.log.info(
      `[TahomaShutter] Polling démarré toutes les ${interval / 1000}s`
    );
  }
  
  async isExecutionFinished(deviceURL, execId) {
    try {
      const devices = await this.callTahomAPI("getDevices");
      const device = devices.find(d => d.deviceURL === deviceURL);
      if (!device || !device.executions) return true;
  
      const exec = device.executions.find(e => e.execId === execId);
      if (!exec) return true; // déjà terminé
      return exec.status !== "IN_PROGRESS";
    } catch (err) {
      this.log.error("[TahomaShutter] Erreur vérification execId:", err);
      return true; // assume finished en cas d'erreur
    }
  }


  async sendSetPosition(deviceURL, homekitValue) {
    // 🔄 Conversion HomeKit → Somfy
    const somfyValue = 100 - homekitValue;
  
    this.log.info(`[TahomaShutter] Commande position: HomeKit=${homekitValue}% → Somfy=${somfyValue}%`);
  
    // tente setClosure puis fallback setPosition
    const body = {
      actions: [
        {
          deviceURL,
          commands: [{ name: "setClosure", parameters: [somfyValue] }]
        }
      ]
    };
  
    try {
      const res = await this.callTahomAPI("exec", body);
      if (res && res.execId) return res.execId;
      return null;
    } catch (err) {
      // fallback
      try {
        const alt = {
          actions: [
            {
              deviceURL,
              commands: [{ name: "setPosition", parameters: [somfyValue] }]
            }
          ]
        };
        const r2 = await this.callTahomAPI("exec", alt);
        if (r2 && r2.execId) return r2.execId;
        return null;
      } catch (e2) {
        this.log.error(`[TahomaShutter] Erreur envoi position (${deviceURL}):`, err.message || err);
        throw err;
      }
    }
  }

  async getShutterState(deviceURL) {
    try {
      const devices = await this.callTahomAPI("getDevices");
      const device = devices.find(d => d.deviceURL === deviceURL);
      if (!device) return { currentPosition: 0, targetPosition: 0 };
  
      // Cherche un état numérique plausible (closure/position)
      let posState = null;
      if (device.states) {
        posState = device.states.find(st => {
          const n = (st.name || "").toLowerCase();
          const isClosure = n.includes("closure") || n.includes("position");
          const isNumber =
            typeof st.value === "number" ||
            (!isNaN(parseFloat(st.value)) && isFinite(st.value));
          return isClosure && isNumber;
        });
      }
  
      let currentPosition = 0;
  
      if (posState) {
        // 🔢 Valeur Somfy brute
        const somfyValue = Math.round(Number(posState.value));
  
        // 🔄 Conversion Somfy → HomeKit (inversion)
        currentPosition = 100 - somfyValue;
        this.log.debug?.(
          `[TahomaShutter] getShutterState(${deviceURL}): Somfy=${somfyValue}% → HomeKit=${currentPosition}%`
        );
      } else {
        // fallback open/closed string
        const openState = device.states.find(st =>
          (st.name || "").toLowerCase().includes("openclosed")
        );
        if (openState && typeof openState.value === "string") {
          currentPosition =
            openState.value === "open"
              ? 100
              : openState.value === "closed"
              ? 0
              : 50;
        } else {
          currentPosition = 0;
        }
      }
  
      const targetPosition = currentPosition;
      return { currentPosition, targetPosition };
    } catch (err) {
      this.log.error("[TahomaShutter] Erreur getShutterState:", err.message || err);
      return { currentPosition: 0, targetPosition: 0 };
    }
  }

  async logAllStates() {
    try {
      const devices = await this.callTahomAPI("getDevices");
      for (const acc of this.accessoriesList) {
        const deviceURL = acc.__deviceURL;
        if (!deviceURL) continue;
        const device = devices.find(d => d.deviceURL === deviceURL);
        if (!device) continue;
        const pos = device.states?.find(st => {
          const n = (st.name || "").toLowerCase();
          return (n.includes("closure") || n.includes("position")) && ((typeof st.value === 'number') || !isNaN(parseFloat(st.value)));
        });
        const v = pos ? pos.value : device.states?.find(s => (s.name||"").toLowerCase().includes("openclosed"))?.value;
        this.log.info(`[TahomaShutter] ${acc.displayName} (${deviceURL}) état: ${v}`);
      }
    } catch (err) {
      this.log.error("[TahomaShutter] Erreur logAllStates:", err.message || err);
    }
  }

  callTahomAPI(cmd, body = null) {
    return new Promise((resolve, reject) => {
      let options;
      let postData = null;

      const [hostPart, portPart] = (this.config.ip || "").split(":");
      const hostname = hostPart;
      const port = parseInt(portPart) || 443;

      if (cmd === "getDevices") {
        options = {
          hostname,
          port,
          path: "/enduser-mobile-web/1/enduserAPI/setup/devices",
          method: "GET",
          headers: { Authorization: "Bearer " + this.config.token },
          rejectUnauthorized: false,
          timeout: 5000
        };
      } else if (cmd === "exec") {
        postData = JSON.stringify(body);
        options = {
          hostname,
          port,
          path: "/enduser-mobile-web/1/enduserAPI/exec/apply",
          method: "POST",
          headers: {
            Authorization: "Bearer " + this.config.token,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData)
          },
          rejectUnauthorized: false,
          timeout: 5000
        };
      } else {
        return reject(new Error("[TahomaShutter] Commande API inconnue: " + cmd));
      }

      const req = https.request(options, (res) => {
        let data = "";
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              let parsed = null;
              try { parsed = JSON.parse(data); } catch (e) { parsed = data; }
              resolve(parsed);
            } else {
              reject(new Error(`[TahomaShutter] HTTP ${res.statusCode}: ${data}`));
            }
          } catch (e) {
            reject(new Error("[TahomaShutter] Erreur parsing JSON: " + e.message));
          }
        });
      });

      req.on("timeout", () => {
        req.destroy();
        reject(new Error("[TahomaShutter] Timeout (5s) atteint, la box Tahoma ne répond pas."));
      });

      req.on("error", err => reject(err));
      if (postData) req.write(postData);
      req.end();
    });
  }
}
