'use strict';

const defaultPool = require('../configs/db');

class BaseRepository {
  constructor(unitOfWork = null, pool = defaultPool) {
    this.unitOfWork = unitOfWork;
    this.pool = pool;
  }

  async getExecutor() {
    if (this.unitOfWork) {
      return this.unitOfWork.getConnection();
    }
    return this.pool;
  }

  async query(sql, params = []) {
    const executor = await this.getExecutor();
    return executor.query({
      sql,
      values: params,
      timeout: this.pool.queryTimeout || 10000,
    });
  }

  async execute(sql, params = []) {
    const executor = await this.getExecutor();
    return executor.execute({
      sql,
      values: params,
      timeout: this.pool.queryTimeout || 10000,
    });
  }
}

module.exports = BaseRepository;
