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
    return executor.query(sql, params);
  }

  async execute(sql, params = []) {
    const executor = await this.getExecutor();
    return executor.execute(sql, params);
  }
}

module.exports = BaseRepository;
