import { api } from "../../api";
import type { CardPolicy } from "../../types";

async function ok(p: Promise<unknown>): Promise<{ ok: boolean }> {
  try {
    await p;
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

export function enableVoWiFi(deviceId: string) {
  return ok(api(`/devices/${deviceId}/vowifi`, { method: "PATCH", body: { enabled: true } }));
}
export function disableVoWiFi(deviceId: string) {
  return ok(api(`/devices/${deviceId}/vowifi`, { method: "PATCH", body: { enabled: false } }));
}
export function setFlightMode(deviceId: string, enabled: boolean) {
  return ok(api(`/devices/${deviceId}/flight-mode`, { method: "PATCH", body: { enabled } }));
}
export interface DJIQMIRepairResult {
  repaired: boolean;
  controlDevice?: string;
  atDevice?: string;
  usbDevice?: string;
  networkInterface?: string;
  qmiProbe?: string;
}
// Restores the factory 2ca3:4006 AT/QMI USB bindings on a DJI 4G module. The
// automatic discovery path already does this; this endpoint re-runs it on
// demand after a reconnect without restarting VoCat.
export function repairDJIQMI() {
  return api<DJIQMIRepairResult>("/devices/actions/repair-dji-qmi", { method: "POST" });
}
export interface DJIUSBInterfaceWire {
  index: number;
  driver: string;
  serialNode?: string;
  qmiNode?: string;
  networkInterface?: string;
}
export interface DJIUSBTopologyWire {
  usbName: string;
  interfaces: DJIUSBInterfaceWire[];
}
export interface DJIRepairAuditWire {
  id: number;
  action: string;
  entityId: string;
  outcome: string;
  details: Record<string, unknown>;
  createdAt: string;
}
export interface DJITopologyResponse {
  topology: DJIUSBTopologyWire;
  audit: DJIRepairAuditWire[];
}
// Read-only USB interface layout plus recent repair history for a configured
// DJI 4G module (device health card).
export function getDJITopology(deviceId: string) {
  return api<DJITopologyResponse>(`/devices/${deviceId}/dji-topology`);
}
// Per-device binding repair, independent of other DJI modules on the bus.
export function repairDeviceDJIQMI(deviceId: string) {
  return api<{ repaired: boolean; atDevice?: string; controlDevice?: string }>(`/devices/${deviceId}/repair-dji-qmi`, { method: "POST" });
}
export interface LatencyTestResult {
  target: string;
  interface?: string;
  sourceIp?: string;
  attempts: number;
  samplesMs?: number[];
  minMs?: number;
  avgMs?: number;
  maxMs?: number;
  path?: string;
  error?: string;
}
// Measures TCP connect latency to a public target over the modem interface.
export function runLatencyTest(deviceId: string, target?: string) {
  const query = target ? `?target=${encodeURIComponent(target)}` : "";
  return api<LatencyTestResult>(`/devices/${deviceId}/latency-test${query}`, { method: "POST" });
}
export function getCardPolicy(iccid: string) {
  return api<CardPolicy>(`/cards/${iccid}/policy`);
}
export interface CardPolicyUpdate {
  vowifiEnabled?: boolean;
  airplaneEnabled?: boolean;
  apn?: string;
  ipVersion?: "IP" | "IPV6" | "IPV4V6";
  customPhoneNumber?: string;
}

export type CellularIMSMode = "mbn_default" | "force_enabled" | "force_disabled";
export interface CellularIMSStatus {
  iccid: string;
  mode: CellularIMSMode;
  desiredEnabled: boolean;
  supported: boolean;
  configured: boolean;
  registered: boolean;
  volteCapable: boolean;
  csKnown: boolean;
  csRegistered: boolean;
  changed: boolean;
  rebooting: boolean;
}
export function getCellularIMS(deviceId: string) {
  return api<CellularIMSStatus>(`/devices/${deviceId}/cellular-ims`);
}
export function setCellularIMSMode(deviceId: string, mode: CellularIMSMode) {
  return api<CellularIMSStatus>(`/devices/${deviceId}/cellular-ims`, { method: "PATCH", body: { mode } });
}
export function updateCardPolicy(iccid: string, body: CardPolicyUpdate) {
  return api<CardPolicy>(`/cards/${iccid}/policy`, { method: "PUT", body });
}
export function putCardPolicy(iccid: string, body: { vowifiEnabled: boolean; airplaneEnabled: boolean }) {
  return ok(updateCardPolicy(iccid, body));
}

export interface ModemAPNProfile {
  cid: number;
  apn: string;
  ipVersion: "IP" | "IPV6" | "IPV4V6";
}
export function getDeviceAPNs(deviceId: string) {
  return api<{ items: ModemAPNProfile[] }>(`/devices/${deviceId}/network/apns`);
}

export interface CardAPNProfile {
  id: number;
  iccid: string;
  apn: string;
  username: string;
  hasPassword: boolean;
  proxy: string;
  mcc: string;
  mnc: string;
  ipVersion: "IP" | "IPV6" | "IPV4V6";
  roamingIpVersion: "IP" | "IPV6" | "IPV4V6";
  authType: "NONE" | "PAP" | "CHAP" | "PAP_OR_CHAP";
  createdAt?: string;
  updatedAt?: string;
}
export function getCardAPNs(iccid: string) {
  return api<{ items: CardAPNProfile[] }>(`/cards/${iccid}/apns`);
}
export interface CardAPNCreate {
  apn: string;
  username: string;
  password: string;
  proxy: string;
  mcc: string;
  mnc: string;
  ipVersion: "IP" | "IPV6" | "IPV4V6";
  roamingIpVersion: "IP" | "IPV6" | "IPV4V6";
  authType: "NONE" | "PAP" | "CHAP" | "PAP_OR_CHAP";
}
export function createCardAPN(iccid: string, body: CardAPNCreate) {
  return api<CardAPNProfile>(`/cards/${iccid}/apns`, { method: "POST", body });
}
export function updateCardAPN(iccid: string, id: number, body: Omit<CardAPNCreate, "password"> & { password?: string; clearPassword?: boolean }) {
  return api<CardAPNProfile>(`/cards/${iccid}/apns/${id}`, { method: "PATCH", body });
}
export function deleteCardAPN(iccid: string, id: number) {
  return api<{ deleted: boolean; id: number }>(`/cards/${iccid}/apns/${id}`, { method: "DELETE" });
}
