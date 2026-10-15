/*
 * 可折叠的 JSON 树形渲染器，负责输出区的 DOM 构建与语法着色。
 *
 * 性能上的关键决策是「子节点惰性渲染」：对象/数组第一次展开时才创建其子节点
 * 的 DOM。MB 级别的 JSON 如果一次性全量构建 DOM 会把 WebView 卡死，而惰性渲染
 * 下首屏只有顶层一层节点，展开多少渲染多少，成本由用户的实际操作摊薄。
 *
 * 所有文本都通过 textContent 写入，不拼 innerHTML，天然免疫注入问题——
 * JSON 里的字符串可能含任意内容，这一点不能靠运气。
 */

/**
 * 把解析后的 JSON 值渲染成一棵可折叠树。
 *
 * @param {unknown} value 已解析（并可能排序过）的 JSON 值
 * @param {HTMLElement} container 输出容器，会被清空后填入树
 * @returns {{ expandAll: () => void, collapseAll: () => void }} 批量折叠控制
 */
export function renderTree(value, container) {
  container.innerHTML = "";

  // 登记所有可折叠节点的展开/收起闭包，供「全部展开 / 全部折叠」统一调度。
  const controllers = [];

  const fragment = document.createDocumentFragment();
  fragment.appendChild(createEntry(null, value, controllers, true));
  container.appendChild(fragment);

  return {
    expandAll() {
      for (const controller of controllers) {
        controller.expand();
      }
    },
    // 根节点保持展开，否则「全部折叠」后只剩一行，用户还得再点一下才能看到顶层键。
    collapseAll() {
      for (let index = 1; index < controllers.length; index += 1) {
        controllers[index].collapse();
      }
    },
  };
}

/**
 * 创建一个树条目（叶子值或可折叠的容器节点）。
 *
 * @param {string | number | null} key 键名（数组成员是下标），根节点传 null
 * @param {unknown} value 该条目的值
 * @param {Array<{ expand: () => void, collapse: () => void }>} controllers 控制闭包登记表
 * @param {boolean} isRoot 是否为根节点（根节点默认展开且不显示键）
 */
function createEntry(key, value, controllers, isRoot = false) {
  if (value !== null && typeof value === "object") {
    return createContainerEntry(key, value, controllers, isRoot);
  }
  return createLeafEntry(key, value);
}

function createContainerEntry(key, value, controllers, isRoot) {
  const isArray = Array.isArray(value);
  const entries = isArray ? value.map((item, index) => [index, item]) : Object.entries(value);
  const [open, close] = isArray ? ["[", "]"] : ["{", "}"];
  const unit = isArray ? "个元素" : "个属性";

  const node = document.createElement("div");
  node.className = "node";

  // 头部：折叠箭头 + 键名 + 开括号 + 折叠时可见的内容预览。
  const header = document.createElement("div");
  header.className = "row";

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "toggle";
  toggle.textContent = "▾";
  toggle.title = "折叠 / 展开";

  const preview = document.createElement("span");
  preview.className = "preview";
  preview.textContent = ` … ${entries.length} ${unit} ${close}`;

  header.appendChild(toggle);
  appendKey(header, key);
  header.appendChild(token(open, "bracket"));
  header.appendChild(preview);

  // 子节点容器与尾部的闭括号行：展开时显示，折叠时隐藏。
  const children = document.createElement("div");
  children.className = "children";

  const footer = document.createElement("div");
  footer.className = "row closing";
  footer.appendChild(token(close, "bracket"));

  /*
   * 惰性渲染的核心：子 DOM 只在第一次展开时构建一次，之后展开/折叠只切
   * display。`rendered` 保证重复展开不会重建，`collapsed` 记录当前状态。
   */
  let rendered = false;
  let collapsed = false;

  const applyState = () => {
    children.style.display = collapsed ? "none" : "";
    footer.style.display = collapsed ? "none" : "";
    preview.style.display = collapsed ? "" : "none";
    toggle.textContent = collapsed ? "▸" : "▾";
  };

  const controller = {
    expand() {
      if (!rendered) {
        rendered = true;
        const fragment = document.createDocumentFragment();
        for (const [childKey, childValue] of entries) {
          fragment.appendChild(createEntry(childKey, childValue, controllers));
        }
        children.appendChild(fragment);
      }
      collapsed = false;
      applyState();
    },
    collapse() {
      // 折叠不强制先渲染：尚未展开过的节点本来就是「折叠」状态。
      collapsed = true;
      applyState();
    },
  };
  controllers.push(controller);

  toggle.addEventListener("click", () => {
    if (collapsed) {
      controller.expand();
    } else {
      controller.collapse();
    }
  });
  // 点击头部任意位置都切换折叠，比只点箭头省力；用判断排除箭头自身的重复触发。
  header.addEventListener("click", (event) => {
    if (event.target !== toggle) {
      toggle.click();
    }
  });

  if (isRoot) {
    controller.expand();
  } else {
    controller.collapse();
  }

  node.append(header, children, footer);
  return node;
}

function createLeafEntry(key, value) {
  const row = document.createElement("div");
  row.className = "row leaf";

  appendKey(row, key);
  row.appendChild(token(stringifyLeaf(value), `value-${typeOf(value)}`));

  return row;
}

/** 追加键名（含冒号）；根节点没有键，跳过。 */
function appendKey(row, key) {
  if (key === null) {
    return;
  }
  // 数组下标与对象键用不同的着色，方便在长数组里辨认位置。
  const label = typeof key === "number" ? String(key) : JSON.stringify(key);
  row.appendChild(token(label, typeof key === "number" ? "index" : "key"));
  row.appendChild(token(": ", "punctuation"));
}

function token(text, className) {
  const span = document.createElement("span");
  span.className = className;
  span.textContent = text;
  return span;
}

/**
 * 叶子值的展示文本。字符串用 JSON.stringify 转义并补引号，
 * 其余类型（number / boolean / null）直接走 String 即可与 JSON 文本一致。
 */
function stringifyLeaf(value) {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

function typeOf(value) {
  if (value === null) {
    return "null";
  }
  return typeof value; // string / number / boolean
}
