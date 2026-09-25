import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <label className="field"><span className="field-title">{label}{hint && <span>{hint}</span>}</span>{children}</label>;
}
export function Button({ children, icon: Icon, onClick, disabled, variant = '' }: { children: ReactNode; icon?: LucideIcon; onClick?: () => void; disabled?: boolean; variant?: string }) {
  return <button type="button" className={`button ${variant}`} disabled={disabled} onClick={onClick}>{Icon && <Icon size={16} strokeWidth={1.8} />}{children}</button>;
}
