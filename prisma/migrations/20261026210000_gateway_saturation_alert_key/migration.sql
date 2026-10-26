-- MOTIR-9675: the gateway-saturation series (design D6) raises its alert in the
-- same raised-alert store as the provider limits, under ONE fixed key:
-- provider 'gateway', model 'connections', limit unit 'saturation'
-- (`lib/capacity/alertKeys.ts`). Widen the two CHECKs to admit exactly it.

ALTER TABLE "capacity_raised_alert" DROP CONSTRAINT "capacity_raised_alert_provider_check";
ALTER TABLE "capacity_raised_alert" ADD CONSTRAINT "capacity_raised_alert_provider_check"
  CHECK ("provider" IN ('claude', 'qwen', 'deepseek', 'gateway'));

ALTER TABLE "capacity_raised_alert" DROP CONSTRAINT "capacity_raised_alert_limit_unit_check";
ALTER TABLE "capacity_raised_alert" ADD CONSTRAINT "capacity_raised_alert_limit_unit_check"
  CHECK ("limit_unit" IN ('max_concurrency', 'rpm', 'input_tpm', 'output_tpm', 'tpm', 'tpd', 'saturation'));

-- The saturation key is the only row 'gateway' or 'saturation' may appear in.
ALTER TABLE "capacity_raised_alert" ADD CONSTRAINT "capacity_raised_alert_saturation_key_check"
  CHECK (
    ("provider" = 'gateway') = ("limit_unit" = 'saturation')
    AND ("provider" <> 'gateway' OR "model" = 'connections')
  );
