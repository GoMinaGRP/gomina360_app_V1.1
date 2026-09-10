/**
 * Shared classification + confirmation metadata for entry forms.
 *
 * Every Sale, Inventory and Asset entry (record/edit) must show a
 * confirmation prompt before its final execution. This module normalises the
 * different entity/type strings used across business modules into one of the
 * three kinds and produces the prompt copy + summary details.
 */

export type EntryKind = "sale" | "inventory" | "asset";

const SALE_ENTITIES = new Set(["SALE", "WASH", "AIRDATA_TXN", "VOUCHER_SELL"]);
const INVENTORY_ENTITIES = new Set(["ITEM", "INVENTORY"]);
const ASSET_ENTITIES = new Set(["ASSET"]);

/** Map a module entity/type string (or shared-module entityType) to a kind. */
export function classifyEntry(entity: string | null | undefined): EntryKind | null {
  const e = String(entity || "").toUpperCase();
  if (SALE_ENTITIES.has(e)) return "sale";
  if (INVENTORY_ENTITIES.has(e)) return "inventory";
  if (ASSET_ENTITIES.has(e)) return "asset";
  return null;
}

export interface EntryConfirmMeta {
  title: string;
  message: string;
  details: { label: string; value: string }[];
  tone: "rose" | "emerald" | "cyan" | "amber" | "indigo" | "purple";
  confirmLabel: string;
}

/** Build the confirmation prompt copy for a given entry kind + form data. */
export function confirmMeta(kind: EntryKind, data: any = {}): EntryConfirmMeta {
  if (kind === "sale") {
    const details: { label: string; value: string }[] = [];
    const customer = data?.customerName || data?.customer || "";
    let amount = data?.amountGhs ?? data?.total ?? data?.amount ?? data?.price ?? data?.totalPrice ?? "";
    if ((amount === "" || amount == null) && data?.sellingPrice != null && data?.quantity != null) {
      amount = Number(data.sellingPrice) * Number(data.quantity);
    }
    if (customer) details.push({ label: "Customer", value: String(customer) });
    if (amount !== "" && amount != null && amount !== undefined) details.push({ label: "Amount", value: `GH₵ ${amount}` });
    if (data?.paymentMethod) details.push({ label: "Payment", value: String(data.paymentMethod) });
    return {
      title: "Confirm Sale",
      message:
        "You're about to record this sale. This will deduct stock (where applicable) and post the revenue to Finance.",
      details,
      tone: "emerald",
      confirmLabel: "Confirm Sale",
    };
  }

  if (kind === "inventory") {
    const details: { label: string; value: string }[] = [];
    if (data?.name) details.push({ label: "Item", value: String(data.name) });
    if (data?.sku) details.push({ label: "SKU", value: String(data.sku) });
    if (data?.quantity != null && data?.quantity !== "") details.push({ label: "Quantity", value: String(data.quantity) });
    return {
      title: "Confirm Inventory Entry",
      message:
        "You're about to save this stock item to the Inventory. It will appear across the business and branch dashboards.",
      details,
      tone: "cyan",
      confirmLabel: "Confirm & Save",
    };
  }

  const details: { label: string; value: string }[] = [];
  if (data?.name) details.push({ label: "Asset", value: String(data.name) });
  if (data?.assetCode) details.push({ label: "Asset Code", value: String(data.assetCode) });
  return {
    title: "Confirm Asset Entry",
    message:
      "You're about to register this asset record. It will be linked to the selected business and branch and appear in reports.",
    details,
    tone: "purple",
    confirmLabel: "Confirm & Register",
  };
}
