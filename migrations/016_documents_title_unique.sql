-- 016_documents_title_unique.sql — 入库幂等的根本保障：同项目内文档标题唯一
-- 数据库级防重：并发入库时也拦得住（应用层查重有竞态窗口）
-- 先清重复（保留每篇最新），再加唯一约束
do $$
declare
  dup record;
begin
  -- 删除同标题的重复文档（保留 created_at 最新的一条，连带清理关联数据）
  for dup in
    select title
    from documents
    group by title, source_id
    having count(*) > 1
  loop
    delete from document_sections ds
      using documents d
      where ds.document_id = d.id
        and d.title = dup.title
        and d.id <> (
          select id from documents d2
          where d2.title = dup.title and d2.source_id = d.source_id
          order by d2.created_at desc limit 1
        );
    delete from source_chunks sc
      using documents d
      where sc.document_id = d.id
        and d.title = dup.title
        and d.id <> (
          select id from documents d2
          where d2.title = dup.title and d2.source_id = d.source_id
          order by d2.created_at desc limit 1
        );
    delete from events e
      using documents d
      where e.document_id = d.id
        and d.title = dup.title
        and d.id <> (
          select id from documents d2
          where d2.title = dup.title and d2.source_id = d.source_id
          order by d2.created_at desc limit 1
        );
    delete from documents d
      where d.title = dup.title
        and d.id <> (
          select id from documents d2
          where d2.title = dup.title and d2.source_id = d.source_id
          order by d2.created_at desc limit 1
        );
  end loop;
end $$;

-- 唯一约束（同项目内标题唯一）
create unique index if not exists documents_title_source_unique
  on documents (title, source_id);
