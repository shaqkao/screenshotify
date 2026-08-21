import { invoke } from "@tauri-apps/api/core";
import { t } from "./i18n.js";
import { toast } from "./toast.js";

/**
 * Right-click menu for the History/Review thumbnails, offering "Copy image".
 * A single shared floating element rather than one per thumbnail — at most
 * one can be open at a time, and building it lazily keeps the (much more
 * common) thumbnail render path untouched.
 */

// assets/copy.svg, 0 -960 960 960 viewBox — inlined so its color follows
// the menu item like every other icon in the app (fill: currentColor),
// instead of the placeholder fill baked into the source file.
const COPY_ICON_PATH =
  "M360-440h400L622-620l-92 120-62-80-108 140ZM120-120q-33 0-56.5-23.5T40-200v-520h80v520h680v80H120Zm160-160q-33 0-56.5-23.5T200-360v-440q0-33 23.5-56.5T280-880h200l80 80h280q33 0 56.5 23.5T920-720v360q0 33-23.5 56.5T840-280H280Zm0-80h560v-360H527l-80-80H280v440Zm0 0v-440 440Z";

let menuEl = null;

function closeMenu() {
  if (!menuEl) return;
  menuEl.remove();
  menuEl = null;
  document.removeEventListener("mousedown", onOutsideClick, true);
  document.removeEventListener("keydown", onKeydown, true);
  window.removeEventListener("blur", closeMenu);
  window.removeEventListener("resize", closeMenu);
}

function onOutsideClick(ev) {
  if (menuEl && !menuEl.contains(ev.target)) closeMenu();
}

function onKeydown(ev) {
  if (ev.key === "Escape") closeMenu();
}

async function copyImage(path) {
  try {
    await invoke("copy_image_to_clipboard", { path });
    toast(t("contextmenu.copied"), { kind: "ok" });
  } catch (err) {
    toast(t("contextmenu.copyFailed", { error: err }), { kind: "err" });
  }
}

/** Opens the menu at viewport coordinates (x, y) for the image at `path`. */
export function showImageContextMenu(x, y, path) {
  closeMenu();

  const menu = document.createElement("div");
  menu.className = "ctx-menu";

  const item = document.createElement("button");
  item.type = "button";
  item.className = "ctx-menu-item";
  item.innerHTML = `<svg class="ctx-menu-icon" viewBox="0 -960 960 960" aria-hidden="true"><path d="${COPY_ICON_PATH}"></path></svg><span></span>`;
  item.querySelector("span").textContent = t("contextmenu.copyImage");
  item.addEventListener("click", () => {
    closeMenu();
    copyImage(path);
  });

  menu.append(item);
  document.body.append(menu);
  menuEl = menu;

  // Positioned after mounting so the menu's real size is known, then clamped
  // inside the viewport so a right-click near an edge doesn't open off-screen.
  const rect = menu.getBoundingClientRect();
  const left = Math.max(6, Math.min(x, window.innerWidth - rect.width - 6));
  const top = Math.max(6, Math.min(y, window.innerHeight - rect.height - 6));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  // Deferred by a tick so the same contextmenu/mousedown that opened this
  // menu doesn't immediately bubble into onOutsideClick and close it again.
  setTimeout(() => {
    document.addEventListener("mousedown", onOutsideClick, true);
    document.addEventListener("keydown", onKeydown, true);
    window.addEventListener("blur", closeMenu);
    window.addEventListener("resize", closeMenu);
  }, 0);
}
