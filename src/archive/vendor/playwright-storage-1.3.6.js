/**
 * Copyright (c) Microsoft Corporation and Cloudflare, Inc.
 * SPDX-License-Identifier: Apache-2.0
 * See LICENSE.playwright and NOTICE.playwright in this directory.
 *
 * Vendored from @cloudflare/playwright 1.3.6:
 * lib/playwright-core/src/generated/storageScriptSource.js
 * Upstream: https://github.com/cloudflare/playwright
 * Injected source SHA-256: 313cdcf194876f26c5185bbff293dec3b585ab5790fc87b8ce9cec3db29a9377
 *
 * Only adaptation: wrap the complete, unchanged generated source in a public
 * page.evaluate-compatible function, then invoke Chromium's StorageScript.restore.
 * Keeping the original serializer preserves encoded IndexedDB values and keys.
 */
export async function restoreOriginStorage(originState) {
  const module = { exports: {} };
  
  var __commonJS = obj => {
    let required = false;
    let result;
    return function __require() {
      if (!required) {
        required = true;
        let fn;
        for (const name in obj) { fn = obj[name]; break; }
        const module = { exports: {} };
        fn(module.exports, module);
        result = module.exports;
      }
      return result;
    }
  };
  var __export = (target, all) => {for (var name in all) target[name] = all[name];};
  var __toESM = mod => ({ ...mod, 'default': mod });
  var __toCommonJS = mod => ({ ...mod, __esModule: true });
  
  
  // packages/injected/src/storageScript.ts
  var storageScript_exports = {};
  __export(storageScript_exports, {
    StorageScript: () => StorageScript
  });
  module.exports = __toCommonJS(storageScript_exports);
  
  // packages/playwright-core/src/utils/isomorphic/utilityScriptSerializers.ts
  function isRegExp(obj) {
    try {
      return obj instanceof RegExp || Object.prototype.toString.call(obj) === "[object RegExp]";
    } catch (error) {
      return false;
    }
  }
  function isDate(obj) {
    try {
      return obj instanceof Date || Object.prototype.toString.call(obj) === "[object Date]";
    } catch (error) {
      return false;
    }
  }
  function isURL(obj) {
    try {
      return obj instanceof URL || Object.prototype.toString.call(obj) === "[object URL]";
    } catch (error) {
      return false;
    }
  }
  function isError(obj) {
    var _a;
    try {
      return obj instanceof Error || obj && ((_a = Object.getPrototypeOf(obj)) == null ? void 0 : _a.name) === "Error";
    } catch (error) {
      return false;
    }
  }
  function isTypedArray(obj, constructor) {
    try {
      return obj instanceof constructor || Object.prototype.toString.call(obj) === `[object ${constructor.name}]`;
    } catch (error) {
      return false;
    }
  }
  var typedArrayConstructors = {
    i8: Int8Array,
    ui8: Uint8Array,
    ui8c: Uint8ClampedArray,
    i16: Int16Array,
    ui16: Uint16Array,
    i32: Int32Array,
    ui32: Uint32Array,
    // TODO: add Float16Array once it's in baseline
    f32: Float32Array,
    f64: Float64Array,
    bi64: BigInt64Array,
    bui64: BigUint64Array
  };
  function typedArrayToBase64(array) {
    if ("toBase64" in array)
      return array.toBase64();
    const binary = Array.from(new Uint8Array(array.buffer, array.byteOffset, array.byteLength)).map((b) => String.fromCharCode(b)).join("");
    return btoa(binary);
  }
  function base64ToTypedArray(base64, TypedArrayConstructor) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++)
      bytes[i] = binary.charCodeAt(i);
    return new TypedArrayConstructor(bytes.buffer);
  }
  function parseEvaluationResultValue(value, handles = [], refs = /* @__PURE__ */ new Map()) {
    if (Object.is(value, void 0))
      return void 0;
    if (typeof value === "object" && value) {
      if ("ref" in value)
        return refs.get(value.ref);
      if ("v" in value) {
        if (value.v === "undefined")
          return void 0;
        if (value.v === "null")
          return null;
        if (value.v === "NaN")
          return NaN;
        if (value.v === "Infinity")
          return Infinity;
        if (value.v === "-Infinity")
          return -Infinity;
        if (value.v === "-0")
          return -0;
        return void 0;
      }
      if ("d" in value) {
        return new Date(value.d);
      }
      if ("u" in value)
        return new URL(value.u);
      if ("bi" in value)
        return BigInt(value.bi);
      if ("e" in value) {
        const error = new Error(value.e.m);
        error.name = value.e.n;
        error.stack = value.e.s;
        return error;
      }
      if ("r" in value)
        return new RegExp(value.r.p, value.r.f);
      if ("a" in value) {
        const result = [];
        refs.set(value.id, result);
        for (const a of value.a)
          result.push(parseEvaluationResultValue(a, handles, refs));
        return result;
      }
      if ("o" in value) {
        const result = {};
        refs.set(value.id, result);
        for (const { k, v } of value.o) {
          if (k === "__proto__")
            continue;
          result[k] = parseEvaluationResultValue(v, handles, refs);
        }
        return result;
      }
      if ("h" in value)
        return handles[value.h];
      if ("ta" in value)
        return base64ToTypedArray(value.ta.b, typedArrayConstructors[value.ta.k]);
    }
    return value;
  }
  function serializeAsCallArgument(value, handleSerializer) {
    return serialize(value, handleSerializer, { visited: /* @__PURE__ */ new Map(), lastId: 0 });
  }
  function serialize(value, handleSerializer, visitorInfo) {
    if (value && typeof value === "object") {
      if (typeof globalThis.Window === "function" && value instanceof globalThis.Window)
        return "ref: <Window>";
      if (typeof globalThis.Document === "function" && value instanceof globalThis.Document)
        return "ref: <Document>";
      if (typeof globalThis.Node === "function" && value instanceof globalThis.Node)
        return "ref: <Node>";
    }
    return innerSerialize(value, handleSerializer, visitorInfo);
  }
  function innerSerialize(value, handleSerializer, visitorInfo) {
    var _a;
    const result = handleSerializer(value);
    if ("fallThrough" in result)
      value = result.fallThrough;
    else
      return result;
    if (typeof value === "symbol")
      return { v: "undefined" };
    if (Object.is(value, void 0))
      return { v: "undefined" };
    if (Object.is(value, null))
      return { v: "null" };
    if (Object.is(value, NaN))
      return { v: "NaN" };
    if (Object.is(value, Infinity))
      return { v: "Infinity" };
    if (Object.is(value, -Infinity))
      return { v: "-Infinity" };
    if (Object.is(value, -0))
      return { v: "-0" };
    if (typeof value === "boolean")
      return value;
    if (typeof value === "number")
      return value;
    if (typeof value === "string")
      return value;
    if (typeof value === "bigint")
      return { bi: value.toString() };
    if (isError(value)) {
      let stack;
      if ((_a = value.stack) == null ? void 0 : _a.startsWith(value.name + ": " + value.message)) {
        stack = value.stack;
      } else {
        stack = `${value.name}: ${value.message}
  ${value.stack}`;
      }
      return { e: { n: value.name, m: value.message, s: stack } };
    }
    if (isDate(value))
      return { d: value.toJSON() };
    if (isURL(value))
      return { u: value.toJSON() };
    if (isRegExp(value))
      return { r: { p: value.source, f: value.flags } };
    for (const [k, ctor] of Object.entries(typedArrayConstructors)) {
      if (isTypedArray(value, ctor))
        return { ta: { b: typedArrayToBase64(value), k } };
    }
    const id = visitorInfo.visited.get(value);
    if (id)
      return { ref: id };
    if (Array.isArray(value)) {
      const a = [];
      const id2 = ++visitorInfo.lastId;
      visitorInfo.visited.set(value, id2);
      for (let i = 0; i < value.length; ++i)
        a.push(serialize(value[i], handleSerializer, visitorInfo));
      return { a, id: id2 };
    }
    if (typeof value === "object") {
      const o = [];
      const id2 = ++visitorInfo.lastId;
      visitorInfo.visited.set(value, id2);
      for (const name of Object.keys(value)) {
        let item;
        try {
          item = value[name];
        } catch (e) {
          continue;
        }
        if (name === "toJSON" && typeof item === "function")
          o.push({ k: name, v: { o: [], id: 0 } });
        else
          o.push({ k: name, v: serialize(item, handleSerializer, visitorInfo) });
      }
      let jsonWrapper;
      try {
        if (o.length === 0 && value.toJSON && typeof value.toJSON === "function")
          jsonWrapper = { value: value.toJSON() };
      } catch (e) {
      }
      if (jsonWrapper)
        return innerSerialize(jsonWrapper.value, handleSerializer, visitorInfo);
      return { o, id: id2 };
    }
  }
  
  // packages/injected/src/storageScript.ts
  var StorageScript = class {
    constructor(isFirefox) {
      this._isFirefox = isFirefox;
      this._global = globalThis;
    }
    _idbRequestToPromise(request) {
      return new Promise((resolve, reject) => {
        request.addEventListener("success", () => resolve(request.result));
        request.addEventListener("error", () => reject(request.error));
      });
    }
    _isPlainObject(v) {
      const ctor = v == null ? void 0 : v.constructor;
      if (this._isFirefox) {
        const constructorImpl = ctor == null ? void 0 : ctor.toString();
        if ((constructorImpl == null ? void 0 : constructorImpl.startsWith("function Object() {")) && (constructorImpl == null ? void 0 : constructorImpl.includes("[native code]")))
          return true;
      }
      return ctor === Object;
    }
    _trySerialize(value) {
      let trivial = true;
      const encoded = serializeAsCallArgument(value, (v) => {
        const isTrivial = this._isPlainObject(v) || Array.isArray(v) || typeof v === "string" || typeof v === "number" || typeof v === "boolean" || Object.is(v, null);
        if (!isTrivial)
          trivial = false;
        return { fallThrough: v };
      });
      if (trivial)
        return { trivial: value };
      return { encoded };
    }
    async _collectDB(dbInfo) {
      if (!dbInfo.name)
        throw new Error("Database name is empty");
      if (!dbInfo.version)
        throw new Error("Database version is unset");
      const db = await this._idbRequestToPromise(indexedDB.open(dbInfo.name));
      if (db.objectStoreNames.length === 0)
        return { name: dbInfo.name, version: dbInfo.version, stores: [] };
      const transaction = db.transaction(db.objectStoreNames, "readonly");
      const stores = await Promise.all([...db.objectStoreNames].map(async (storeName) => {
        const objectStore = transaction.objectStore(storeName);
        const keys = await this._idbRequestToPromise(objectStore.getAllKeys());
        const records = await Promise.all(keys.map(async (key) => {
          const record = {};
          if (objectStore.keyPath === null) {
            const { encoded: encoded2, trivial: trivial2 } = this._trySerialize(key);
            if (trivial2)
              record.key = trivial2;
            else
              record.keyEncoded = encoded2;
          }
          const value = await this._idbRequestToPromise(objectStore.get(key));
          const { encoded, trivial } = this._trySerialize(value);
          if (trivial)
            record.value = trivial;
          else
            record.valueEncoded = encoded;
          return record;
        }));
        const indexes = [...objectStore.indexNames].map((indexName) => {
          const index = objectStore.index(indexName);
          return {
            name: index.name,
            keyPath: typeof index.keyPath === "string" ? index.keyPath : void 0,
            keyPathArray: Array.isArray(index.keyPath) ? index.keyPath : void 0,
            multiEntry: index.multiEntry,
            unique: index.unique
          };
        });
        return {
          name: storeName,
          records,
          indexes,
          autoIncrement: objectStore.autoIncrement,
          keyPath: typeof objectStore.keyPath === "string" ? objectStore.keyPath : void 0,
          keyPathArray: Array.isArray(objectStore.keyPath) ? objectStore.keyPath : void 0
        };
      }));
      return {
        name: dbInfo.name,
        version: dbInfo.version,
        stores
      };
    }
    async collect(recordIndexedDB) {
      const localStorage = Object.keys(this._global.localStorage).map((name) => ({ name, value: this._global.localStorage.getItem(name) }));
      if (!recordIndexedDB)
        return { localStorage };
      try {
        const databases = await this._global.indexedDB.databases();
        const indexedDB2 = await Promise.all(databases.map((db) => this._collectDB(db)));
        return { localStorage, indexedDB: indexedDB2 };
      } catch (e) {
        throw new Error("Unable to serialize IndexedDB: " + e.message);
      }
    }
    async _restoreDB(dbInfo) {
      const openRequest = this._global.indexedDB.open(dbInfo.name, dbInfo.version);
      openRequest.addEventListener("upgradeneeded", () => {
        var _a, _b;
        const db2 = openRequest.result;
        for (const store of dbInfo.stores) {
          const objectStore = db2.createObjectStore(store.name, { autoIncrement: store.autoIncrement, keyPath: (_a = store.keyPathArray) != null ? _a : store.keyPath });
          for (const index of store.indexes)
            objectStore.createIndex(index.name, (_b = index.keyPathArray) != null ? _b : index.keyPath, { unique: index.unique, multiEntry: index.multiEntry });
        }
      });
      const db = await this._idbRequestToPromise(openRequest);
      if (db.objectStoreNames.length === 0)
        return;
      const transaction = db.transaction(db.objectStoreNames, "readwrite");
      await Promise.all(dbInfo.stores.map(async (store) => {
        const objectStore = transaction.objectStore(store.name);
        await Promise.all(store.records.map(async (record) => {
          var _a, _b;
          await this._idbRequestToPromise(
            objectStore.add(
              (_a = record.value) != null ? _a : parseEvaluationResultValue(record.valueEncoded),
              (_b = record.key) != null ? _b : parseEvaluationResultValue(record.keyEncoded)
            )
          );
        }));
      }));
    }
    async restore(originState) {
      var _a, _b, _c;
      const registrations = this._global.navigator.serviceWorker ? await this._global.navigator.serviceWorker.getRegistrations() : [];
      await Promise.all(registrations.map(async (r) => {
        if (!r.installing && !r.waiting && !r.active)
          r.unregister().catch(() => {
          });
        else
          await r.unregister().catch(() => {
          });
      }));
      try {
        for (const db of await ((_b = (_a = this._global.indexedDB).databases) == null ? void 0 : _b.call(_a)) || []) {
          if (db.name)
            this._global.indexedDB.deleteDatabase(db.name);
        }
        await Promise.all(((_c = originState == null ? void 0 : originState.indexedDB) != null ? _c : []).map((dbInfo) => this._restoreDB(dbInfo)));
      } catch (e) {
        throw new Error("Unable to restore IndexedDB: " + e.message);
      }
      this._global.sessionStorage.clear();
      this._global.localStorage.clear();
      for (const { name, value } of (originState == null ? void 0 : originState.localStorage) || [])
        this._global.localStorage.setItem(name, value);
    }
  };
  return new (module.exports.StorageScript())(false).restore(originState);
}
