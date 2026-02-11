import { Box, Text } from "ink";
import type { Tenant, TenantWatchState } from "../types/index.js";
import { TenantRow } from "./TenantRow.js";
import { LOBSTER } from "./theme.js";

export interface TenantExtraInfo {
  ip: string;
  vmPid: string;
  memoryMb?: number;
}

interface Props {
  tenants: Tenant[];
  states: Record<string, TenantWatchState>;
  lastTick: string | null;
  extraInfo?: Record<string, TenantExtraInfo>;
}

export function Dashboard({ tenants, states, lastTick, extraInfo }: Props) {
  const healthy = Object.values(states).filter(
    (s) => s.state === "HEALTHY",
  ).length;
  const degraded = Object.values(states).filter(
    (s) => s.state === "DEGRADED",
  ).length;
  const failed = Object.values(states).filter(
    (s) => s.state === "FAILED",
  ).length;

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text bold>
          {LOBSTER} lobsterd — {tenants.length} tenant(s)
        </Text>
      </Box>

      <Box marginBottom={1} gap={2}>
        <Text color="green">● {healthy} healthy</Text>
        <Text color="yellow">◐ {degraded} degraded</Text>
        <Text color="red">✗ {failed} failed</Text>
      </Box>

      <Box flexDirection="column" gap={0}>
        <Box gap={2} marginBottom={1}>
          <Box width={20}>
            <Text bold underline>
              TENANT
            </Text>
          </Box>
          <Box width={8}>
            <Text bold underline>
              PORT
            </Text>
          </Box>
          <Box width={16}>
            <Text bold underline>
              IP
            </Text>
          </Box>
          <Box width={8}>
            <Text bold underline>
              PID
            </Text>
          </Box>
          <Box width={6}>
            <Text bold underline>
              MEM
            </Text>
          </Box>
          <Box width={12}>
            <Text bold underline>
              STATE
            </Text>
          </Box>
          <Text bold underline>
            CHECKS
          </Text>
        </Box>
        {tenants.map((t) => {
          const extra = extraInfo?.[t.name];
          return (
            <TenantRow
              key={t.name}
              name={t.name}
              port={t.gatewayPort}
              ip={extra?.ip}
              vmPid={extra?.vmPid}
              memoryMb={extra?.memoryMb}
              watchState={
                states[t.name] ?? {
                  state: "UNKNOWN",
                  lastCheck: null,
                  lastResults: [],
                  repairAttempts: 0,
                  lastRepairAt: null,
                }
              }
            />
          );
        })}
      </Box>

      {lastTick && (
        <Box marginTop={1}>
          <Text dimColor>Last check: {lastTick}</Text>
        </Box>
      )}
    </Box>
  );
}
