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
    "file.save": "fs:save",
    "log.write": "log:write",
    "net.request": "net:request",
    "notify.send": "ui:notify",
    "screen.capture": "screen:capture",
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

    // 图片读取与文本读取共用 clipboard:read 权限：宿主读的是同一份剪贴板资源，
    // 只是内容类型不同。返回的是可直接交给 `<img>` 的完整 data URL（宿主按实际来源
    // 决定 MIME），剪贴板里没有图片时返回 null，由插件决定提示文案。
    clipboard.readImage = function () {
      return invoke("read_plugin_clipboard_image", {
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

  /*
   * 导出文件：宿主会弹出系统保存对话框，落盘位置由用户当场选定，所以这不是「任意路径
   * 写权限」。调用返回保存后的完整路径，用户取消则返回 null；插件应当把路径显示出来，
   * 只说一句「已保存」用户并不知道文件去了哪。
   *
   * contents 传 base64 载荷（不含 data URL 前缀）：图片这类二进制跨 IPC 只能走文本，
   * 文本文件也套用同一种形态，插件端不必为内容类型分两条路径。
   */
  if (has(CAPABILITY_TABLE["file.save"])) {
    api.file = Object.freeze({
      save: function (fileName, contents) {
        return invoke("save_plugin_file", {
          pluginId: config.id,
          fileName: text(fileName),
          contents: text(contents),
        });
      },
    });
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

  // 屏幕截图：宿主会弹出全屏框选层让用户亲手拖出区域，因此这个调用会一直悬着，
  // 直到用户松开鼠标（resolve 为 PNG base64）或取消（resolve 为 null）。插件侧要按
  // 「可能等待较久」来设计，不要在调用前后锁死界面。
  if (has(CAPABILITY_TABLE["screen.capture"])) {
    api.screen = Object.freeze({
      capture: function () {
        return invoke("capture_plugin_screen_region", {
          pluginId: config.id,
        });
      },
    });
  }

  // 窗口命名空间：无边框插件窗口的自定义标题栏用来发起系统拖动。它不进 CAPABILITY_TABLE，
  // 因为拖动是 UI 行为而非「能力」——任何插件窗口都能拖自己，无需在 plugin.json 里声明。
  var windowNamespace = {
    startDragging: function () {
      // 拖动必须在 mousedown 同步发起，OS 才会接管。直接调 Tauri 窗口插件的拖动命令，
      // 授权走 capability（core:window:allow-start-dragging），不占用宿主能力命令清单。
      // label 取「调用方自己」：插件窗口标签固定为 plugin_<id>，由宿主建窗时写死，
      // 与 domain/plugin/contract.rs 的 PLUGIN_WINDOW_LABEL_PREFIX 一致，插件改不了，
      // 因此只可能拖到自己，不存在拖别人窗口的空间。
      return invoke("plugin:window|start_dragging", {
        label: "plugin_" + config.id,
      });
    },
  };

  api.window = Object.freeze(windowNamespace);

  window.dasktop = Object.freeze(api);
})();
