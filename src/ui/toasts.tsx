export type ToastTone = "info" | "ok" | "warn" | "error";

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface ToastItem {
  id: number;
  tone: ToastTone;
  title: string;
  text: string;
  actions: ToastAction[];
}

let toastSeq = 1;

export function createToast(tone: ToastTone, title: string, text: string, actions: ToastAction[] = []): ToastItem {
  toastSeq += 1;
  return { id: toastSeq, tone, title, text, actions: actions.slice(0, 2) };
}

export function ToastStack({ items, onClose }: { items: ToastItem[]; onClose: (id: number) => void }) {
  if (items.length === 0) return null;
  return (
    <div className="toasts" role="region" aria-label="Сообщения">
      {items.map((item) => (
        <article key={item.id} className={`toast toast-${item.tone}`} role="status">
          <header>
            <strong>{item.title}</strong>
            <button type="button" className="btn btn-ghost" aria-label="Закрыть сообщение" onClick={() => onClose(item.id)}>×</button>
          </header>
          {item.text ? <p>{item.text}</p> : null}
          {item.actions.length > 0 ? (
            <div className="row">
              {item.actions.map((action) => (
                <button key={action.label} type="button" className="btn btn-secondary" onClick={() => { action.run(); onClose(item.id); }}>{action.label}</button>
              ))}
            </div>
          ) : null}
        </article>
      ))}
    </div>
  );
}
