/**
 * 数据库层常量（无任何依赖的叶子模块）
 *
 * 单独成文件的目的：
 * database.ts 与 wordRepository.ts 互相需要这些常量，但二者本身是
 * database.ts ← wordRepository.ts 的单向依赖（repository 依赖 database 取连接）。
 * 若把常量定义在 wordRepository.ts 并让 database.ts 反向导入，会形成循环依赖，
 * 打包工具与测试环境的模块初始化顺序都不可控。因此常量下沉到此处，双方共同引用。
 */

/** 数据库名称（唯一入口，便于自检与多标签页逻辑复用） */
export const DB_NAME = "yanyu-1000";

/**
 * 演示测试词的来源标记。
 * 空库首次打开时会自动种入 6 个演示词；正式词库导入后会被清理或原地接管。
 * 该值一旦发布即视为数据契约的一部分（已写入用户本地数据），不可随意修改，
 * 否则历史数据中的测试词将无法被识别。
 */
export const TEST_WORD_SOURCE = "测试词库";
