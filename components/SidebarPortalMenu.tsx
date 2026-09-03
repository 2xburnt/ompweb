"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

const MENU_MARGIN = 5;
const MENU_VIEWPORT_PAD = 8;

/**
 * Overflow menu rendered through a portal to document.body so it always
 * floats above every sidebar row: it is never clipped by the workspace list's
 * overflow and never covered by sibling stacking contexts (each workspace
 * section isolates its own context). Positioned from the anchor button's
 * viewport rect, flips to the other side of the anchor when there is no room,
 * follows the anchor while the sidebar scrolls, and closes on outside press
 * or Escape. Arrow keys move focus between the enabled buttons inside.
 */
export function SidebarPortalMenu({
  anchor,
  open,
  onClose,
  placement = "below",
  align = "end",
  minWidth = 136,
  style,
  children,
}: {
  anchor: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  placement?: "below" | "above";
  /** "end" right-aligns to the anchor, "start" left-aligns to it. */
  align?: "start" | "end";
  minWidth?: number;
  style?: CSSProperties;
  children: ReactNode;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // Refs are passed as arguments so the callback stays dependency-clean
  // (no ref.current access inside) for the React Compiler.
  const computePos = useCallback((el: HTMLElement | null, menu: HTMLDivElement | null) => {
    if (!el || !menu) return;
    const r = el.getBoundingClientRect();
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    // --ui-scale / zoom makes getBoundingClientRect() scaled while offsetWidth is unscaled.
    // Convert the anchor rect to unscaled CSS pixels so the fixed menu (also zoomed) lands correctly.
    let scale = 1;
    if (typeof document !== "undefined") {
      const raw = getComputedStyle(document.documentElement).getPropertyValue("--ui-scale");
      const v = parseFloat(raw);
      if (Number.isFinite(v) && v > 0) scale = v;
    }
    const ru = scale !== 1 ? { top: r.top / scale, right: r.right / scale, bottom: r.bottom / scale, left: r.left / scale } : r;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let top: number;
    if (placement === "above") {
      top = ru.top - height - MENU_MARGIN;
      if (top < MENU_VIEWPORT_PAD) {
        top = Math.min(ru.bottom + MENU_MARGIN, vh - height - MENU_VIEWPORT_PAD);
      }
    } else {
      top = ru.bottom + MENU_MARGIN;
      if (top + height > vh - MENU_VIEWPORT_PAD) {
        top = ru.top - height - MENU_MARGIN;
      }
    }
    if (top < MENU_VIEWPORT_PAD) top = MENU_VIEWPORT_PAD;
    const left = align === "start"
      ? Math.max(MENU_VIEWPORT_PAD, Math.min(ru.left, vw - width - MENU_VIEWPORT_PAD))
      : Math.max(MENU_VIEWPORT_PAD, Math.min(ru.right - width, vw - width - MENU_VIEWPORT_PAD));
    setPos({ top, left });
  }, [placement, align]);

  // Measure on open: the portal is mounted during commit, so the menu's own
  // size is available synchronously in the layout effect.
  useLayoutEffect(() => {
    if (!open) return;
    computePos(anchor.current, menuRef.current);
  }, [open, computePos, anchor]);

  // Reposition while open — the sidebar is resizable and the list scrolls.
  useEffect(() => {
    if (!open) return;
    const update = () => computePos(anchor.current, menuRef.current);
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [open, computePos, anchor]);

  // Close on outside press / Escape and handle keyboard arrow navigation.
  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => {
      const firstBtn = menuRef.current?.querySelector<HTMLButtonElement>("button:not([disabled])");
      firstBtn?.focus();
    }, 0);
    const onPointerDown = (e: MouseEvent | TouchEvent) => {
      const target = e.target as Node;
      if (anchor.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        e.preventDefault();
        onClose();
        anchor.current?.focus();
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const buttons = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ?? []);
        if (buttons.length === 0) return;
        const currentIndex = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const nextIndex = e.key === "ArrowDown"
          ? (currentIndex + 1) % buttons.length
          : (currentIndex - 1 + buttons.length) % buttons.length;
        buttons[nextIndex]?.focus();
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("touchstart", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("touchstart", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onClose, anchor]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      style={{
        position: "fixed",
        top: pos ? pos.top : -9999,
        left: pos ? pos.left : -9999,
        visibility: pos ? "visible" : "hidden",
        zIndex: 1000,
        minWidth,
        padding: 4,
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-control)",
        background: "var(--bg-panel)",
        boxShadow: "var(--shadow-pop)",
        ...style,
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
