import { ArrowLeftRight, CircleAlert, CreditCard, Gem, Lock, PenLine, ScanSearch, Truck, type LucideIcon } from "lucide-react";
import { StepBar } from "./shop";

const ICONS: Record<string, LucideIcon> = {
  Signed: PenLine,
  "Deposits locked": Lock,
  "At the vault": Truck,
  "Cards at the vault": Truck,
  "Inspection passed": ScanSearch,
  "Inspected & swapped": ArrowLeftRight,
  Paid: CreditCard,
  Delivered: Gem,
};

/** Icon step bar for an order or swap, plus the reason when it ended early. */
export function Timeline({ steps, current, failed }: { steps: string[]; current: number; failed?: string }) {
  return (
    <div className="panel px-3 py-5 sm:px-5">
      <StepBar steps={steps.map((label) => ({ label, icon: ICONS[label] ?? PenLine }))} current={current} />
      {failed && (
        <div className="mt-5 flex items-start gap-2 rounded-lg border border-down/40 bg-down/10 px-3 py-2 text-sm text-down">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          {failed}
        </div>
      )}
    </div>
  );
}
