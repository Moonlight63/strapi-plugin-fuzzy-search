/* eslint-disable @typescript-eslint/no-explicit-any */
import { Core } from '@strapi/strapi';
import {
  ContentType,
  PaginationArgs,
  SearchResponseArgs,
  SearchResponseReturnType,
} from '../interfaces/interfaces';
import getResult from '../services/fuzzySearch-service';
import { buildGraphqlResponse } from '../services/response-transformation-service';
import settingsService from '../services/settings-service';
import { pipe, prop, defaultTo } from 'lodash/fp';

const getCustomTypes = (strapi: Core.Strapi, nexus: any) => {
  const { service: getService } = strapi.plugin('graphql');
  const { naming } = getService('utils');
  const { utils } = getService('builders');
  const { contentTypes } = settingsService().get();
  const {
    getEntityResponseCollectionName,
    getFindQueryName,
    getFiltersInputTypeName,
    getTypeName
  } = naming;
  const { transformArgs, getContentTypeArgs } = utils;

  const extendSearchResponseType = (nexus: any, model: ContentType) => {
    return nexus.objectType({
      name: getEntityResponseCollectionName(model)+"Search",
      definition(t) {
        t.nonNull.list.field("nodes", { 
          type: nexus.nonNull(getTypeName(model)),
          resolve: pipe(prop('nodes'), defaultTo([]))
        });
        t.nonNull.field("pageInfo", { 
          type: "Pagination",
          resolve: pipe(prop('pageInfo'), defaultTo({ total: 0, page: 0, pageSize: 0, pageCount: 0 })),
        });
      },
    })
  }

  // Extend the SearchResponse type for each registered model
  const extendSearchType = (nexus: any, model: ContentType) => {
    return nexus.extendType({
      type: 'SearchResponse',
      definition(t: any) {
        t.field(getFindQueryName(model), {
          type: getEntityResponseCollectionName(model)+"Search" as any,
          args: getContentTypeArgs(model, { multiple: true }),
          async resolve(
            parent: SearchResponseReturnType,
            args: {
              pagination?: PaginationArgs;
              filters?: Record<string, unknown>;
              locale?: string;
              status?: 'published' | 'draft';
            },
            ctx: any,
            info
          ) {
            const { query, locale: parentLocaleQuery } = parent;
            const {
              pagination,
              filters,
              locale: contentTypeLocaleQuery,
              status: contentTypeStatusQuery,
            } = args;

            const locale = contentTypeLocaleQuery || parentLocaleQuery;

            const {
              start: transformedStart,
              limit: transformedLimit,
              filters: transformedFilters,
            } = transformArgs(
              { pagination, filters },
              {
                contentType: model,
                usePagination: true,
              },
            );

            const contentType = contentTypes.find(
              (contentType) => contentType.modelName === model.modelName,
            );

            if (!contentType) return;

            const results = await getResult({
              contentType,
              query,
              filters: transformedFilters,
              populate: undefined,
              locale,
              status: contentTypeStatusQuery,
            });

            const resultsResponse = await buildGraphqlResponse(
              results.fuzzysortResults,
              contentType,
              ctx.state?.auth,
              { start: transformedStart, limit: transformedLimit },
            );

            const total = results.fuzzysortResults.length;
            const { start: finalStart, limit: finalLimit } = resultsResponse.info.args;
            const safeLimit = Math.max(finalLimit, 1);
            const pageSize = finalLimit === -1 ? total - finalStart : safeLimit;
            const pageCount = finalLimit === -1 ? safeLimit : Math.ceil(total / safeLimit);
            const page = finalLimit === -1 ? safeLimit : Math.floor(finalStart / safeLimit) + 1;

            resultsResponse.pageInfo = { total, page, pageSize, pageCount };

            if (resultsResponse) return resultsResponse;

            throw new Error(ctx.koaContext.response.message);
          },
        });
      },
    });
  };

  const searchResponseType = nexus.extendType({
    type: 'Query',
    definition(t: any) {
      t.field('search', {
        type: 'SearchResponse',
        args: {
          query: nexus.nonNull(
            nexus.stringArg(
              'The query string by which the models are searched',
            ),
          ),
          locale: nexus.stringArg('The locale by which to filter the models'),
        },
        async resolve(
          _parent: any,
          args: SearchResponseArgs,
          ctx: any,
        ): Promise<SearchResponseReturnType> {
          const { query, locale } = args;
          const { auth } = ctx.state;

          return { query, locale, auth };
        },
      });
    },
  });

  const returnTypes = [searchResponseType];

  contentTypes.forEach((type) => {
    returnTypes.unshift(extendSearchResponseType(nexus, type));
    returnTypes.unshift(extendSearchType(nexus, type));
  });

  return returnTypes;
};

export default getCustomTypes;
