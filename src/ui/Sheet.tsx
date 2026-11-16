/** Bottom sheet and content-row primitives. */

import { useEffect, useId, useRef, type ReactNode } from 'react';
import { IconClose } from './Icons';

export interface SheetProps {
  open: boolean;
  title: string;
  subtitle?: string | null;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  labelId?: string;
}

export function Sheet({ open, title, subtitle, onClose, children, footer }: SheetProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    const timer = window.setTimeout(() => dialogRef.current?.focus(), 60);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      window.clearTimeout(timer);
    };
  }, [open, onClose]);

  return (
    <div className={`sheet-root ${open ? 'is-open' : ''}`} aria-hidden={!open}>
      <div className="sheet-backdrop" onClick={onClose} />
      <section
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={dialogRef}
        tabIndex={-1}
      >
        <div className="sheet__handle" aria-hidden="true" />
        <header className="sheet__header">
          <div className="sheet__heading">
            <h2 className="sheet__title" id={titleId}>
              {title}
            </h2>
            {subtitle ? <p className="sheet__subtitle">{subtitle}</p> : null}
          </div>
          <button type="button" className="sheet__close" onClick={onClose} aria-label="Close">
            <IconClose size={16} />
          </button>
        </header>
        <div className="sheet__body">{children}</div>
        {footer ? <footer className="sheet__footer">{footer}</footer> : null}
      </section>
    </div>
  );
}

export function Section({
  title,
  aside,
  children,
  note,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
  note?: ReactNode;
}) {
  return (
    <section className="section">
      <h3 className="section__title">
        <span>{title}</span>
        {aside}
      </h3>
      {children}
      {note ? <p className="section__note">{note}</p> : null}
    </section>
  );
}

export function Row({
  label,
  hint,
  value,
  onClick,
  children,
  className = '',
}: {
  label: ReactNode;
  hint?: ReactNode;
  value?: ReactNode;
  onClick?: () => void;
  children?: ReactNode;
  className?: string;
}) {
  const content = (
    <>
      <span className="row__main">
        <span className="row__label">{label}</span>
        {hint ? <span className="row__hint">{hint}</span> : null}
      </span>
      {value !== undefined ? <span className="row__value">{value}</span> : null}
      {children}
    </>
  );

  if (onClick) {
    return (
      <button type="button" className={`row row--button ${className}`} onClick={onClick}>
        {content}
      </button>
    );
  }
  return <div className={`row ${className}`}>{content}</div>;
}
