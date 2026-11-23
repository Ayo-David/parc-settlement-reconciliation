import type { Knex } from "knex";

/**
 * Ported from parc-ledger src/services/admin-report-window.ts (repositories
 * cannot import from each other); keep the two in step.
 *
 * ADR-010 A: the shared shape of administrator reports. A report covers whole
 * calendar days in the tenant's business-day timezone, at most 92 of them,
 * bucketed by day, ISO week or month. Every bucket in range is present so a
 * chart never skips a quiet period. Counts and minor-unit amounts are integer
 * strings; ratios are integer basis points. No row about an individual
 * customer is ever returned.
 */
export const reportGranularities = ["DAY", "WEEK", "MONTH"] as const;
export type ReportGranularity = (typeof reportGranularities)[number];
export const maximumReportDays = 92;
/** Used when no timezone is given or it isn't a known IANA name. */
export const defaultReportTimezone = "Africa/Lagos";

export interface ReportRequest {
  tenantId: string;
  from: string;
  to: string;
  granularity: ReportGranularity;
  timezone?: string | undefined;
}

export interface ReportWindow {
  tenantId: string;
  timezone: string;
  timezoneSource: "REQUEST" | "DEFAULT";
  /** Inclusive start and exclusive end, as instants. */
  start: Date;
  end: Date;
  from: string;
  to: string;
  granularity: ReportGranularity;
  buckets: string[];
}

export interface MetricRow {
  bucket: string;
  /** Money metrics are split by currency. */
  currency?: string | null;
  /** A further split, such as a failure code; null when the metric has none. */
  dimension?: string | null;
  value: string;
}

export interface ReportMetric {
  metric: string;
  unit: "COUNT" | "MINOR" | "BASIS_POINTS";
  rows: (tx: Knex.Transaction, window: ReportWindow) => Promise<MetricRow[]>;
}

/** Days in the period, both ends included. */
export function reportDays(from: string, to: string): number {
  return (
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
      86_400_000 +
    1
  );
}

/** SQL for the bucket a timestamptz column falls in, in the report's timezone. */
export function bucketOf(column: string, window: ReportWindow): string {
  return `to_char(date_trunc('${window.granularity.toLowerCase()}', ${column} AT TIME ZONE '${window.timezone}'), 'YYYY-MM-DD')`;
}

/** SQL for the bucket a date column falls in. */
export function bucketOfDate(column: string, window: ReportWindow): string {
  return `to_char(date_trunc('${window.granularity.toLowerCase()}', ${column}::timestamp), 'YYYY-MM-DD')`;
}

export async function reportWindow(
  tx: Knex.Transaction,
  request: ReportRequest,
): Promise<ReportWindow> {
  const requested = request.timezone;
  const known =
    requested !== undefined &&
    (
      await tx.raw<{ rows: { known: boolean }[] }>(
        "SELECT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = ?) AS known",
        [requested],
      )
    ).rows[0]?.known === true;
  // Only a name PostgreSQL knows reaches the SQL fragments above.
  const timezone = known ? requested : defaultReportTimezone;
  const unit = request.granularity.toLowerCase();
  const {
    rows: [bounds],
  } = await tx.raw<{ rows: { start: Date; end: Date; buckets: string[] }[] }>(
    `SELECT (?::date)::timestamp AT TIME ZONE ? AS start,
       ((?::date) + 1)::timestamp AT TIME ZONE ? AS "end",
       ARRAY(
         SELECT to_char(bucket, 'YYYY-MM-DD')
         FROM generate_series(
           date_trunc(?, (?::date)::timestamp),
           date_trunc(?, (?::date)::timestamp),
           ('1 ' || ?)::interval
         ) AS bucket
       ) AS buckets`,
    [
      request.from,
      timezone,
      request.to,
      timezone,
      unit,
      request.from,
      unit,
      request.to,
      unit,
    ],
  );
  if (bounds === undefined) throw new Error("Report window was not computed");
  return {
    tenantId: request.tenantId,
    timezone,
    timezoneSource: known ? "REQUEST" : "DEFAULT",
    start: bounds.start,
    end: bounds.end,
    from: request.from,
    to: request.to,
    granularity: request.granularity,
    buckets: bounds.buckets,
  };
}

/** Runs each metric and fills every bucket, one series per metric and currency. */
export async function buildReport(
  tx: Knex.Transaction,
  report: string,
  request: ReportRequest,
  metrics: ReportMetric[],
) {
  const window = await reportWindow(tx, request);
  const series = [];
  for (const metric of metrics) {
    // One transaction client runs one query at a time.
    const rows = await metric.rows(tx, window);
    const keyOf = (row: MetricRow) =>
      JSON.stringify([row.currency?.trim() ?? null, row.dimension ?? null]);
    const keys = [...new Set(rows.map(keyOf))].sort();
    // A count with no rows still has a (zero) series; money needs a currency.
    if (keys.length === 0 && metric.unit !== "MINOR")
      keys.push(JSON.stringify([null, null]));
    for (const key of keys) {
      const [currency, dimension] = JSON.parse(key) as [
        string | null,
        string | null,
      ];
      const values = new Map(
        rows
          .filter((row) => keyOf(row) === key)
          .map((row) => [row.bucket, row.value]),
      );
      series.push({
        metric: metric.metric,
        unit: metric.unit,
        currency,
        dimension,
        points: window.buckets.map((bucket) => ({
          bucket,
          value: values.get(bucket) ?? "0",
        })),
      });
    }
  }
  return {
    report,
    tenant_id: request.tenantId,
    from: window.from,
    to: window.to,
    granularity: window.granularity,
    timezone: window.timezone,
    timezone_source: window.timezoneSource,
    generated_at: new Date().toISOString(),
    series,
  };
}
