'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Wallet, TrendingUp } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { canEditSettings } from '@/lib/auth/roles';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import { Skeleton } from '@/components/dashboard/skeleton';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table';

// AED has been pegged to the US dollar at this exact rate since 1997 —
// a static constant, not a live FX lookup. message_billing stores
// every cost in USD (Meta bills in USD); this is purely a display
// conversion for a UAE-based account.
const AED_PER_USD = 3.6725;

const CATEGORY_ORDER = ['marketing', 'service', 'utility', 'authentication'] as const;
type BillingCategory = (typeof CATEGORY_ORDER)[number];

interface CategoryBreakdown {
  category: BillingCategory;
  count: number;
  cost_usd: number;
}

interface BillingSummary {
  billing_month: string;
  has_data: boolean;
  days_elapsed: number;
  days_in_month: number;
  total_count: number;
  total_cost_usd: number;
  free_tier_used: number;
  free_tier_limit: number;
  projected_cost_usd: number;
  by_category: CategoryBreakdown[];
}

// Matches currency.ts's own convention (Intl.NumberFormat(undefined, ...))
// rather than threading the next-intl locale through — number/currency
// formatting in this app follows the runtime's own locale, not the UI
// translation locale.
function formatAed(usd: number): string {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'AED',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format((Number(usd) || 0) * AED_PER_USD);
}

/**
 * Per-client WhatsApp message-cost card for Settings → WhatsApp.
 * Admin-only (spend is billing-class), same gate as `AiUsageCard`.
 *
 * Reads GET /api/whatsapp/billing, which wraps the
 * get_message_billing_summary() RPC (migration 053) — a single round
 * trip for the whole card, no client-side aggregation.
 *
 * The webhook doesn't write message_billing yet (wiring lands after
 * 1 October 2026), so `has_data` is false for every account today.
 * This card renders the "cost tracking hasn't started" empty state
 * until the first row exists — no flag, no redeploy needed once it
 * does.
 */
export function WhatsAppBillingCard() {
  const t = useTranslations('Settings.whatsappBilling');
  const { accountId, accountRole, profileLoading } = useAuth();
  const canView = accountRole ? canEditSettings(accountRole) : false;

  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<BillingSummary | null>(null);
  const loadedRef = useRef<string | null>(null);

  const fetchSummary = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/whatsapp/billing', { cache: 'no-store' });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        toast.error(json?.error ?? t('loadFailed'));
        setData(null);
        return;
      }
      setData(json as BillingSummary);
    } catch {
      toast.error(t('loadFailed'));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (!canView || !accountId) return;
    // Refetch on account switch, same guard AiUsageCard uses.
    if (loadedRef.current === accountId) return;
    loadedRef.current = accountId;
    void fetchSummary();
  }, [canView, accountId, fetchSummary]);

  if (profileLoading || !canView) return null;

  const freeTierPct = data
    ? Math.min(100, (data.free_tier_used / data.free_tier_limit) * 100)
    : 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Wallet className="h-4 w-4 text-primary" /> {t('title')}
        </CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {loading || !data ? (
          <Skeleton className="h-[220px] w-full" />
        ) : !data.has_data ? (
          <div className="flex flex-col items-center justify-center gap-2 py-10 text-center text-sm text-muted-foreground">
            <Wallet className="h-8 w-8 opacity-40" />
            <p>{t('emptyTitle')}</p>
            <p className="text-xs">{t('emptyDesc')}</p>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Stat label={t('monthToDate')} value={formatAed(data.total_cost_usd)} />
              <Stat
                label={t('projectedMonthEnd')}
                value={formatAed(data.projected_cost_usd)}
                icon={TrendingUp}
              />
            </div>

            <div>
              <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
                <span>{t('freeTierLabel')}</span>
                <span className="tabular-nums">
                  {t('freeTierUsed', {
                    used: data.free_tier_used,
                    limit: data.free_tier_limit,
                  })}
                </span>
              </div>
              <div
                role="progressbar"
                aria-valuenow={data.free_tier_used}
                aria-valuemin={0}
                aria-valuemax={data.free_tier_limit}
                className="h-2 w-full overflow-hidden rounded-full bg-muted"
              >
                <div
                  className="h-full rounded-full bg-primary transition-all"
                  style={{ width: `${freeTierPct}%` }}
                />
              </div>
            </div>

            <div>
              <p className="mb-2 text-xs font-medium text-muted-foreground">
                {t('breakdownTitle')}
              </p>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('categoryHeader')}</TableHead>
                    <TableHead className="text-end">{t('countHeader')}</TableHead>
                    <TableHead className="text-end">{t('costHeader')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {CATEGORY_ORDER.map((cat) => {
                    const row =
                      data.by_category.find((c) => c.category === cat) ?? {
                        category: cat,
                        count: 0,
                        cost_usd: 0,
                      };
                    return (
                      <TableRow key={cat}>
                        <TableCell>{t(`category.${cat}`)}</TableCell>
                        <TableCell className="text-end tabular-nums">
                          {row.count}
                        </TableCell>
                        <TableCell className="text-end tabular-nums">
                          {row.cost_usd === 0 ? t('free') : formatAed(row.cost_usd)}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Stat({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: string;
  icon?: typeof Wallet;
}) {
  return (
    <div className="rounded-md border border-border p-3">
      <p className="flex items-center gap-1 text-xs text-muted-foreground">
        {Icon && <Icon className="h-3 w-3" />}
        {label}
      </p>
      <p className="mt-1 text-lg font-semibold tabular-nums text-foreground">
        {value}
      </p>
    </div>
  );
}
