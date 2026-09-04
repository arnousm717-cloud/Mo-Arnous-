-- Enable pgvector (docs/11-AI-Revenue-Brain.md, Milestone 4.1 Brain Foundation).
-- Schema-only prerequisite: no embeddings are generated and no vector index
-- is created in this migration. See 20260905090100_create_brain_schema.sql
-- for the brain_embeddings.embedding vector(1536) column that depends on it.

create extension if not exists vector;
