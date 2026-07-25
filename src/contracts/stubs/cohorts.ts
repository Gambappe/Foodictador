import type { Cohorts } from '../modules.js';
import type { CohortStat, Driver, Read, UsualProfile } from '../types.js';

/** Usual trait → driver mapping, carried from plan v1.0 §7 Lane B. */
export function driversForUsual(usual: UsualProfile): Driver[] {
  const drivers: Driver[] = [];
  if (usual.spiceTolerance <= 1) drivers.push('spice_tolerance_low');
  if (usual.budgetBand <= 2) drivers.push('budget_ceiling');
  if (usual.portionPref === 'small') drivers.push('portion_small');
  if (usual.soloComfort) drivers.push('solo_comfort');
  if (usual.giConstraint) drivers.push('gi_constraint');
  return drivers;
}

/** Census with read_id dedup ([E20]); K6 owns the hardened version. */
export class StubCohorts implements Cohorts {
  census(reads: Read[]): CohortStat[] {
    const byId = new Map<string, Read>();
    for (const read of reads) if (!byId.has(read.read_id)) byId.set(read.read_id, read);
    const byDriver = new Map<Driver, Read[]>();
    for (const read of byId.values()) {
      byDriver.set(read.driver, [...(byDriver.get(read.driver) ?? []), read]);
    }
    return [...byDriver.entries()].map(([driver, members]) => ({
      driver,
      k: members.length,
      meanWeight: members.reduce((sum, r) => sum + r.weight, 0) / members.length,
      placeIds: [...new Set(members.map((r) => r.place))],
    }));
  }

  matched(usual: UsualProfile, reads: Read[], kFloor = 5): CohortStat[] {
    const wanted = new Set(driversForUsual(usual));
    return this.census(reads).filter((stat) => wanted.has(stat.driver) && stat.k >= kFloor);
  }
}
