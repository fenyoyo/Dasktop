/*
 * 能力桥：宿主在每个插件页面加载前把它注入窗口，插件用 `window.dasktop` 调用宿主能力。
 *
 * 四条必须守住的约定
 *
 * 1. **这层只是便利包装，不是安全边界**。真正的判据在 Rust 侧：谁在调（调用方窗口的
 *    标签）、能不能调（插件清单里声明的权限）。插件把自己的页面改成直接
 *    `window.__TAURI_INTERNALS__.invoke(...)` 完全绕不过这层，但宿主那边照样会拒。
 *    反过来说，别把「插件只能通过 dasktop 调」当安全假设。
 * 2. **只挂载清单里声明过的能力**。没声明的插件看到的是 `dasktop.net` 根本不存在，
 *    比「调了才报错」更早暴露配置问题。这份权限集合与宿主同源，都来自 plugin.json。
 * 3. **`__TAURI_INTERNALS__` 必须延迟取用**。本脚本与 Tauri 自己的初始化脚本谁先执行
 *    没有保证，IIFE 执行的那一刻它可能还没挂上，所以只在真正发起调用时才去读。
 * 4. **CAPABILITY_TABLE 是给校验脚本读的**，格式别改：一行一项，形如
 *    `"命名空间.方法": "权限字符串"`。`scripts/verify-plugins.mjs` 用它把插件源码里出现的
 *    `dasktop.xxx.yyy(...)` 映射成权限，核对清单有没有声明。
 */
(function () {
  "use strict";

  var CAPABILITY_TABLE = {
    "clipboard.read": "clipboard:read",
    "clipboard.write": "clipboard:write",
    "fs.read": "fs:read",
    "fs.write": "fs:write",
    "log.write": "log:write",
    "net.request": "net:request",
    "notify.send": "ui:notify",
  };

  var config = window.__DASKTOP_BRIDGE__;

  if (!config || typeof config.id !== "string") {
    return;
  }

  var declared = Array.isArray(config.permissions) ? config.permissions : [];

  function has(permission) {
    return declared.indexOf(permission) >= 0;
  }

  function invoke(command, payload) {
    var internals = window.__TAURI_INTERNALS__;

    if (!internals || typeof internals.invoke !== "function") {
      return Promise.reject(new Error("宿主调用通道不可用：当前页面不是由 Dasktop 打开的"));
    }

    return internals.invoke(command, payload);
  }

  function text(value) {
    if (typeof value === "string") {
      return value;
    }

    return value === null || value === undefined ? "" : String(value);
  }

  /*
   * 请求只挑已知字段，不整体透传：插件多写一个字段不该变成后端反序列化失败，
   * 而错误信息会指向「参数不匹配」，与真正的原因（多传了字段）隔得很远。
   */
  function pickRequest(options) {
    var source = options || {};
    var request = { url: text(source.url) };

    if (source.method !== undefined && source.method !== null) {
      request.method = text(source.method);
    }

    if (source.body !== undefined && source.body !== null) {
      request.body = text(source.body);
    }

    if (source.headers && typeof source.headers === "object") {
      var headers = {};

      Object.keys(source.headers).forEach(function (key) {
        headers[key] = text(source.headers[key]);
      });

      request.headers = headers;
    }

    return request;
  }

  var api = {
    plugin: Object.freeze({
      id: config.id,
      name: text(config.name),
      version: text(config.version),
      permissions: Object.freeze(declared.slice()),
    }),
    has: has,
  };

  var clipboard = {};

  if (has(CAPABILITY_TABLE["clipboard.read"])) {
    clipboard.read = function () {
      return invoke("read_plugin_clipboard_text", {
        pluginId: config.id,
      });
    };
  }

  if (has(CAPABILITY_TABLE["clipboard.write"])) {
    clipboard.write = function (value) {
      return invoke("write_plugin_clipboard_text", {
        pluginId: config.id,
        text: text(value),
      });
    };
  }

  if (Object.keys(clipboard).length > 0) {
    api.clipboard = Object.freeze(clipboard);
  }

  var fs = {};

  if (has(CAPABILITY_TABLE["fs.read"])) {
    fs.read = function (path) {
      return invoke("read_plugin_package_file", {
        pluginId: config.id,
        relativePath: text(path),
      });
    };
  }

  if (has(CAPABILITY_TABLE["fs.write"])) {
    fs.write = function (path, contents) {
      return invoke("write_plugin_package_file", {
        pluginId: config.id,
        relativePath: text(path),
        contents: text(contents),
      });
    };
  }

  if (Object.keys(fs).length > 0) {
    api.fs = Object.freeze(fs);
  }

  if (has(CAPABILITY_TABLE["log.write"])) {
    api.log = Object.freeze({
      write: function (level, message) {
        return invoke("write_plugin_log", {
          pluginId: config.id,
          level: text(level),
          message: text(message),
        });
      },
    });
  }

  if (has(CAPABILITY_TABLE["net.request"])) {
    api.net = Object.freeze({
      request: function (options) {
        return invoke("plugin_http_request", {
          pluginId: config.id,
          request: pickRequest(options),
        });
      },
    });
  }

  if (has(CAPABILITY_TABLE["notify.send"])) {
    api.notify = Object.freeze({
      send: function (title, message) {
        return invoke("notify_from_plugin", {
          pluginId: config.id,
          title: text(title),
          message: text(message),
        });
      },
    });
  }

  window.dasktop = Object.freeze(api);
})();
