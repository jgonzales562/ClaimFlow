import Link from "next/link";
import React, { type ReactNode } from "react";
import { cx, formatPercent, type PillTone } from "@/lib/ui";

type PageHeroProps = {
  eyebrow: string;
  title: string;
  subtitle: ReactNode;
  compact?: boolean;
  breadcrumbHref?: string;
  breadcrumbLabel?: string;
  meta?: ReactNode;
  note?: ReactNode;
  actions?: ReactNode;
};

type PanelSectionProps = {
  kicker: string;
  title: string;
  copy?: ReactNode;
  accessory?: ReactNode;
  className?: string;
  children: ReactNode;
};

type TableSectionProps = {
  kicker: string;
  title: string;
  copy?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
};

type StatCardProps = {
  label: string;
  value: ReactNode;
  note: ReactNode;
};

type WorkflowMeterProps = {
  label: string;
  meta: ReactNode;
  percent: number;
  tone: PillTone;
};

type GlanceCardProps = {
  label: string;
  value: ReactNode;
  copy: ReactNode;
  tone: PillTone;
};

type NoticeBannerProps = {
  tone: "success" | "danger";
  children: ReactNode;
};

type KeyValueRowProps = {
  label: string;
  value: ReactNode;
};

export function PageHero({
  eyebrow,
  title,
  subtitle,
  compact = false,
  breadcrumbHref,
  breadcrumbLabel,
  meta,
  note,
  actions,
}: PageHeroProps) {
  return (
    <section className={cx("hero-card", compact && "hero-card--compact")}>
      <div>
        {breadcrumbHref && breadcrumbLabel ? (
          <p className="hero-breadcrumb">
            <Link href={breadcrumbHref} className="hero-link">
              {breadcrumbLabel}
            </Link>
          </p>
        ) : null}
        <p className="eyebrow">{eyebrow}</p>
        <h1 className="page-title">{title}</h1>
        <p className="page-subtitle">{subtitle}</p>
      </div>

      {meta || note || actions ? (
        <div className="hero-meta">
          {meta ? <div className="hero-details">{meta}</div> : null}
          {note ? <p className="hero-note">{note}</p> : null}
          {actions ? <div className="hero-actions">{actions}</div> : null}
        </div>
      ) : null}
    </section>
  );
}

export function PanelSection({
  kicker,
  title,
  copy,
  accessory,
  className,
  children,
}: PanelSectionProps) {
  return (
    <section className={cx("surface-card panel section-stack", className)}>
      <SectionHeading kicker={kicker} title={title} copy={copy} accessory={accessory} />
      {children}
    </section>
  );
}

export function TableSection({ kicker, title, copy, aside, children }: TableSectionProps) {
  return (
    <section className="surface-card table-card">
      <div className="table-toolbar">
        <div>
          <p className="section-kicker">{kicker}</p>
          <h2 className="section-title">{title}</h2>
          {copy ? <p className="section-copy">{copy}</p> : null}
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}

export function StatCard({ label, value, note }: StatCardProps) {
  return (
    <article className="stat-card">
      <p className="stat-label">{label}</p>
      <strong className="stat-value">{value}</strong>
      <p className="stat-note">{note}</p>
    </article>
  );
}

export function Pill({
  tone,
  children,
  className,
}: {
  tone: PillTone;
  children: ReactNode;
  className?: string;
}) {
  return <span className={cx("pill", `pill--${tone}`, className)}>{children}</span>;
}

export function WorkflowMeter({ label, meta, percent, tone }: WorkflowMeterProps) {
  return (
    <div className="workflow-row">
      <div className="workflow-heading">
        <div className="cluster">
          <Pill tone={tone}>{label}</Pill>
          <p className="workflow-meta">{meta}</p>
        </div>
        <span className="workflow-percent">{formatPercent(percent)}</span>
      </div>
      <div className="workflow-track" aria-hidden="true">
        <div
          className={cx("workflow-fill", `workflow-fill--${tone}`)}
          style={{ width: `${percent > 0 ? Math.max(percent, 4) : 0}%` }}
        />
      </div>
    </div>
  );
}

export function GlanceCard({ label, value, copy, tone }: GlanceCardProps) {
  return (
    <article className={cx("glance-card", `glance-card--${tone}`)}>
      <p className="glance-label">{label}</p>
      <h3 className="glance-value">{value}</h3>
      <p className="glance-copy">{copy}</p>
    </article>
  );
}

export function NoticeBanner({ tone, children }: NoticeBannerProps) {
  return (
    <p className={cx("notice", tone === "success" ? "notice--success" : "notice--danger")}>
      {children}
    </p>
  );
}

export function KeyValueRow({ label, value }: KeyValueRowProps) {
  return (
    <div className="kv-row">
      <p className="kv-label">{label}</p>
      <div className="kv-value">{value}</div>
    </div>
  );
}

function SectionHeading({
  kicker,
  title,
  copy,
  accessory,
}: {
  kicker: string;
  title: string;
  copy?: ReactNode;
  accessory?: ReactNode;
}) {
  return (
    <div className="section-heading">
      <div>
        <p className="section-kicker">{kicker}</p>
        <h2 className="section-title">{title}</h2>
        {copy ? <p className="section-copy">{copy}</p> : null}
      </div>
      {accessory}
    </div>
  );
}
