'use strict';

const defaultPool = require('../configs/db');

class UnitOfWork {
  constructor(pool = defaultPool) {
    this.pool = pool;
    this.connection = null;
    this.inTransaction = false;
  }

  async getConnection() {
    if (!this.connection) {
      this.connection = await this.pool.getConnection();
    }
    return this.connection;
  }

  async beginTransaction() {
    const conn = await this.getConnection();
    await conn.beginTransaction();
    this.inTransaction = true;
  }

  async commit() {
    if (this.connection && this.inTransaction) {
      await this.connection.commit();
      this.inTransaction = false;
    }
  }

  async rollback() {
    if (this.connection && this.inTransaction) {
      await this.connection.rollback();
      this.inTransaction = false;
    }
  }

  async release() {
    if (this.connection) {
      if (this.inTransaction) {
        try {
          await this.rollback();
        } catch (err) {
          console.error('[UnitOfWork] Rollback during release failed:', err.message);
        }
      }
      this.connection.release();
      this.connection = null;
    }
  }

  static async runInTransaction(workFn, pool = defaultPool) {
    const uow = new UnitOfWork(pool);
    try {
      await uow.beginTransaction();
      const result = await workFn(uow);
      await uow.commit();
      return result;
    } catch (error) {
      await uow.rollback();
      throw error;
    } finally {
      await uow.release();
    }
  }
}

module.exports = UnitOfWork;
