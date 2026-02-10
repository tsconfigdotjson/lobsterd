import React from 'react';
import { Box, Text } from 'ink';
import type { TenantWatchState, HealthCheckResult } from '../types/index.js';
import { WATCH_STATE_COLORS, WATCH_STATE_SYMBOLS, STATUS_SYMBOLS, STATUS_COLORS } from './theme.js';

interface Props {
  name: string;
  port: number;
  watchState: TenantWatchState;
}

function CheckBadge({ label, results }: { label: string; results: HealthCheckResult[] }) {
  const worst = results.reduce<'ok' | 'degraded' | 'failed'>((acc, r) => {
    if (r.status === 'failed') return 'failed';
    if (r.status === 'degraded' && acc !== 'failed') return 'degraded';
    return acc;
  }, 'ok');

  return (
    <Text color={STATUS_COLORS[worst]}>
      {STATUS_SYMBOLS[worst]} {label}
    </Text>
  );
}

export function TenantRow({ name, port, watchState }: Props) {
  const stateColor = WATCH_STATE_COLORS[watchState.state];
  const stateSymbol = WATCH_STATE_SYMBOLS[watchState.state];

  // Group results by category
  const dockerResults = watchState.lastResults.filter((r) => r.check.startsWith('docker.'));
  const gatewayResults = watchState.lastResults.filter((r) => r.check.startsWith('gateway.'));
  const zfsResults = watchState.lastResults.filter((r) => r.check.startsWith('zfs.'));
  const fsResults = watchState.lastResults.filter((r) => r.check.startsWith('fs.'));

  return (
    <Box gap={2}>
      <Box width={20}>
        <Text color={stateColor} bold>
          {stateSymbol} {name}
        </Text>
      </Box>
      <Box width={8}>
        <Text dimColor>:{port}</Text>
      </Box>
      <Box width={12}>
        <Text color={stateColor}>{watchState.state}</Text>
      </Box>
      <Box gap={1}>
        {dockerResults.length > 0 && <CheckBadge label="Docker" results={dockerResults} />}
        {gatewayResults.length > 0 && <CheckBadge label="GW" results={gatewayResults} />}
        {zfsResults.length > 0 && <CheckBadge label="ZFS" results={zfsResults} />}
        {fsResults.length > 0 && <CheckBadge label="FS" results={fsResults} />}
      </Box>
    </Box>
  );
}
