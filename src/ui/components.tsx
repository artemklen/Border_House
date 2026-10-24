import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Icon } from "./icons";

type Variant = "primary" | "secondary" | "ghost" | "danger";

export function Button({
  variant = "secondary",
  icon,
  children,
  confirm,
  onClick,
  disabled,
  pressed,
}: {
  variant?: Variant;
  icon?: string;
  children: ReactNode;
  confirm?: { title: string; lines: string[]; confirmLabel?: string };
  onClick?: () => void;
  disabled?: boolean;
  pressed?: boolean;
}) {
  const [ask, setAsk] = useState(false);
  return (
    <>
      <button
        type="button"
        className={`btn btn-${variant}`}
        disabled={disabled}
        aria-pressed={pressed}
        onClick={() => {
          if (variant === "danger") setAsk(true);
          else onClick?.();
        }}
      >
        {icon ? <Icon name={icon} size={18} /> : null}
        <span>{children}</span>
      </button>
      {ask ? (
        <ConfirmDialog
          title={confirm?.title ?? "Подтвердите действие"}
          lines={confirm?.lines ?? ["Действие изменит партию. Отмена оставит всё как есть."]}
          confirmLabel={confirm?.confirmLabel ?? "Подтвердить"}
          danger
          onConfirm={() => {
            setAsk(false);
            onClick?.();
          }}
          onCancel={() => setAsk(false)}
        />
      ) : null}
    </>
  );
}

export function Badge({ tone = "neutral", children }: { tone?: "neutral" | "info" | "ok" | "warn" | "error"; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function Tab({
  selected,
  count,
  children,
  onClick,
}: {
  selected: boolean;
  count?: number;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button type="button" role="tab" className="tab" aria-selected={selected} onClick={onClick}>
      <span>{children}</span>
      {count != null && count > 0 ? <span className="tab-count">{count}</span> : null}
    </button>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <span className="field-control">{children}</span>
      {error ? <span className="field-error">{error}</span> : hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

export function Hint({ text, label = "Пояснение" }: { text: string; label?: string }) {
  const id = useId();
  return (
    <span className="hint">
      <button type="button" className="hint-btn" aria-label={label} aria-describedby={id}>?</button>
      <span role="tooltip" id={id} className="hint-pop">{text}</span>
    </span>
  );
}

export function KpiTile({ label, value, sub, tone = "neutral" }: { label: string; value: string; sub?: string; tone?: "neutral" | "ok" | "warn" | "error" }) {
  return (
    <article className={`kpi kpi-${tone}`}>
      <span className="kpi-label">{label}</span>
      <strong className="kpi-value">{value}</strong>
      {sub ? <span className="kpi-sub">{sub}</span> : null}
    </article>
  );
}

export function Card({ title, extra, children }: { title?: string; extra?: ReactNode; children: ReactNode }) {
  return (
    <article className="card">
      {title || extra ? (
        <header className="card-head">
          {title ? <h3>{title}</h3> : <span />}
          {extra}
        </header>
      ) : null}
      {children}
    </article>
  );
}

export function ConfirmDialog({
  title,
  lines,
  confirmLabel = "Подтвердить",
  danger = false,
  onConfirm,
  onCancel,
}: {
  title: string;
  lines: string[];
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement | null>(null);
  useEffect(() => {
    const dialog = ref.current;
    const focus = dialog?.querySelector<HTMLButtonElement>("[data-confirm]");
    focus?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onCancel]);
  return (
    <dialog ref={ref} open className="confirm" onCancel={(event) => { event.preventDefault(); onCancel(); }}>
      <h2>{title}</h2>
      {lines.map((line) => <p key={line}>{line}</p>)}
      <div className="row">
        <button type="button" className={danger ? "btn btn-danger" : "btn btn-primary"} data-confirm onClick={onConfirm}>{confirmLabel}</button>
        <button type="button" className="btn btn-secondary" onClick={onCancel}>Отмена</button>
      </div>
    </dialog>
  );
}

export function Meter({ value, max, label }: { value: number; max: number; label: string }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <span className="meter" role="img" aria-label={label}>
      <span style={{ width: `${pct}%` }} />
    </span>
  );
}
