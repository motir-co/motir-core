-- Bug MOTIR-11992 (ADR `approval-gates.md` §12.20): with the review gate on, no PRIMARY
-- question (design, decision, acceptance) is asked before the review at the current
-- delivery-set version has passed. A primary already awaiting when the review is owed is
-- withdrawn under this cause, and the pass asks it again. Expand-only.
ALTER TYPE "approval_gate_supersede_cause" ADD VALUE IF NOT EXISTS 'review_not_passed';
