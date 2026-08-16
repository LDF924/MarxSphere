#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""统一的 Neo4j 连接封装，消除各模块重复实现"""

from typing import Dict, List, Optional
from neo4j import GraphDatabase


class Neo4jConnection:
    def __init__(self, uri: str = None, user: str = None, password: str = None):
        if uri is None:
            from .config import get_neo4j_config
            cfg = get_neo4j_config()
            uri = cfg["uri"]
            user = cfg["user"]
            password = cfg["password"]
        self.driver = GraphDatabase.driver(uri, auth=(user, password))

    def close(self):
        self.driver.close()

    def execute_query(self, query: str, params: Dict = None) -> List[Dict]:
        with self.driver.session() as session:
            result = session.run(query, params or {})
            return [record.data() for record in result]

    def execute_write(self, query: str, params: Dict = None):
        with self.driver.session() as session:
            session.run(query, params or {})

    def new_session(self):
        """Return a raw Neo4j driver session for advanced operations"""
        return self.driver.session()
