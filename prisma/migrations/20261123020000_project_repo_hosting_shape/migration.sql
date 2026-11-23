-- MOTIR-12093: a Motir repo's hosting decision records its AWS release SHAPE
-- (decision MOTIR-5769 §4: a Lambda `function` or an ECS Fargate `container`).
-- The AWS deploy port refuses a release with no shape, and production had no
-- recorded shape to pass it. ADDITIVE: a nullable column on an existing table,
-- no row written; every existing repository reads NULL until its hosting
-- decision records one.

-- CreateEnum
CREATE TYPE "hosting_shape" AS ENUM ('function', 'container');

-- AlterTable
ALTER TABLE "project_repository" ADD COLUMN     "hosting_shape" "hosting_shape";
