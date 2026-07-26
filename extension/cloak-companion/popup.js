const ZONES = [
  "UTC",
  "Europe/Amsterdam", "Europe/London", "Europe/Paris", "Europe/Berlin",
  "Europe/Madrid", "Europe/Moscow",
  "Asia/Shanghai", "Asia/Hong_Kong", "Asia/Tokyo", "Asia/Singapore",
  "Asia/Seoul", "Asia/Taipei", "Asia/Bangkok", "Asia/Dubai", "Asia/Kolkata",
  "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles",
  "America/Sao_Paulo", "Australia/Sydney", "Pacific/Auckland",
];

const sel = document.getElementById("tz");
const cur = document.getElementById("cur");
const engineEl = document.getElementById("engine");
const warn = document.getElementById("warn");
const st = document.getElementById("status");

// Content scripts do not run on extension pages, so this popup's own Intl is the
// engine's zone — the same one a page's Web Worker reports, and the one no
// content script can reach.
const engineZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

function render(tz) {
  cur.textContent = tz || "无(跟随内核)";
  engineEl.textContent = engineZone;
  warn.textContent = tz && tz !== engineZone
    ? "页面与 Worker 时区不一致,读取 Worker 的检测脚本能看出伪装。想彻底一致,请用带该时区的账号重新启动。"
    : "";
}

async function load() {
  const { tz } = await chrome.storage.local.get("tz");
  const list = Array.from(new Set([tz, ...ZONES].filter(Boolean)));
  sel.replaceChildren();
  for (const z of list) {
    const opt = new Option(z, z); // Option() sets text safely (no HTML parsing)
    if (z === tz) opt.selected = true;
    sel.add(opt);
  }
  render(tz);
}

async function apply(tz) {
  await chrome.storage.local.set({ tz });
  render(tz);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) chrome.tabs.reload(tab.id);
}

sel.addEventListener("change", () => apply(sel.value));

document.getElementById("auto").addEventListener("click", async () => {
  st.textContent = "检测中…";
  const z = await chrome.runtime.sendMessage({ type: "detectTZ" });
  if (z) {
    if (![...sel.options].some((o) => o.value === z)) {
      sel.add(new Option(z, z), 0);
    }
    sel.value = z;
    await apply(z);
    st.textContent = "已匹配 IP:" + z;
  } else {
    st.textContent = "检测失败,请手动选择";
  }
});

load();
