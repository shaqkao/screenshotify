const host = () => document.getElementById("toasts");

/**
 * Small in-window toast. `action` adds a button (used for "Undo" right after
 * a rename, which is where undo is actually wanted).
 */
export function toast(message, { kind = "info", action = null, timeout = 5000 } = {}) {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;

  const text = document.createElement("span");
  text.textContent = message;
  el.append(text);

  let timer = null;
  const close = () => {
    if (timer) clearTimeout(timer);
    el.remove();
  };

  if (action) {
    const btn = document.createElement("button");
    btn.className = "btn btn-sm";
    btn.textContent = action.label;
    btn.addEventListener("click", () => {
      close();
      action.onClick();
    });
    el.append(btn);
  }

  host().append(el);
  if (timeout) timer = setTimeout(close, timeout);
  return close;
}
