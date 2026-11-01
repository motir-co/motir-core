-- MOTIR-9808: a Motir repo's row records its hosting target, use case and size
-- (Story MOTIR-9791, decision MOTIR-5769). All three columns are nullable and
-- this migration writes no row: every existing repository reads NULL until the
-- plan's hosting decision or build directly sets them.

-- CreateEnum
CREATE TYPE "hosting_target" AS ENUM ('serverless', 'fly', 'aws');

-- CreateEnum
CREATE TYPE "hosting_use_case" AS ENUM ('internal_tool', 'mvp', 'planned_product');

-- CreateEnum
CREATE TYPE "hosting_size" AS ENUM ('small', 'medium', 'large');

-- AlterTable
ALTER TABLE "project_repository" ADD COLUMN     "hosting_size" "hosting_size",
ADD COLUMN     "hosting_target" "hosting_target",
ADD COLUMN     "hosting_use_case" "hosting_use_case";
