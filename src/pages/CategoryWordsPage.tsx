import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  getCategoryStudyQueue,
  type CategoryStudyItem,
} from "@/lib/categoryStudyService";
import { NO_SUBCATEGORY, groupLabel, parseGroupKey } from "@/lib/categoryService";

/** 二级分类词语列表页 */
export default function CategoryWordsPage() {
  const { groupKey = "", sub = "" } = useParams();
  const subName = decodeURIComponent(sub);
  const navigate = useNavigate();
  const [items, setItems] = useState<CategoryStudyItem[] | null>(null);

  const { section, groupId } = parseGroupKey(groupKey);

  useEffect(() => {
    (async () => {
      setItems(
        await getCategoryStudyQueue(groupId, section, subName, NO_SUBCATEGORY),
      );
    })();
  }, [groupId, section, subName]);

  if (!items) {
    return (
      <div className="page-container">
        <p className="mt-10 text-center text-slate-400">正在加载…</p>
      </div>
    );
  }

  const unlearned = items.filter((i) => !i.learned).length;
  const first = items[0]?.word;
  const title = first?.groupTitle
    ? groupLabel({ groupId, groupTitle: first.groupTitle })
    : "";

  return (
    <div className="page-container">
      <Link
        to="/category"
        className="mb-4 inline-flex items-center gap-1 text-sm text-brand-600"
      >
        ‹ 返回分类
      </Link>

      <header className="mb-4">
        <h1 className="text-xl font-semibold">{subName}</h1>
        <p className="mt-1 text-xs text-slate-400">
          {section}
          {title ? ` · ${title}` : ""} · 共 {items.length} 词 · 待学 {unlearned}
        </p>
      </header>

      <button
        className="btn-primary mb-4 w-full"
        disabled={items.length === 0}
        onClick={() =>
          navigate(`/category/${groupKey}/${encodeURIComponent(subName)}/study`)
        }
      >
        开始本分类学习
      </button>

      {items.length === 0 && (
        <div className="card text-center">
          <p className="text-sm text-slate-500">该分类下暂无词语</p>
        </div>
      )}

      <ul className="space-y-2.5">
        {items.map(({ word, learned }) => (
          <li key={word.id}>
            <button
              className="card w-full p-4 text-left active:scale-[0.99]"
              onClick={() => navigate(`/wordbook/${word.id}`)}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-base font-medium">{word.term}</span>
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] ${
                    learned
                      ? "bg-success-500/10 text-success-500"
                      : "bg-slate-100 text-slate-500"
                  }`}
                >
                  {learned ? "已学习" : "待学习"}
                </span>
              </div>
              <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-slate-500">
                {word.definition}
              </p>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
