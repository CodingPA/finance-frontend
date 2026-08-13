import { useEffect, type ReactNode } from "react";

interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Wider, scrollable variant for content-heavy modals (forms + lists). */
  wide?: boolean;
  /** Extra class(es) on the dialog element, for callers that need more than
   *  the wide/default sizing (e.g. a user-resizable variant). */
  className?: string;
}

export function Modal({ title, onClose, children, wide, className }: ModalProps) {
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  // Close only when the mousedown itself started on the backdrop, not on a
  // `click` bubbling up -- a native drag-resize (or a text selection) that
  // starts inside the dialog but releases past its edge would otherwise
  // register as a backdrop click and close the modal mid-drag.
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className={[wide ? "dialog dialog-lg" : "dialog", className].filter(Boolean).join(" ")}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="dialog-title">{title}</div>
        {children}
        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
