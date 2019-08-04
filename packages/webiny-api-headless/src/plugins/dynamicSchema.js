import pluralize from "pluralize";
import * as resolve from "webiny-api/graphql";
import { registerPlugins, getPlugins } from "webiny-plugins";
import { createTypeName, createManageTypeName, createReadTypeName } from "../utils/createTypeName";
import { resolveGet } from "../utils/resolveGet";
import { resolveList } from "../utils/resolveList";
import { resolveCreate } from "../utils/resolveCreate";
import { resolveUpdate } from "../utils/resolveUpdate";
import TypeValueEmitter from "../utils/TypeValueEmitter";

const commonFieldResolvers = () => ({
    id: entry => (entry._id ? entry._id.toString() : null),
    createdBy: (entry, args, context) => {
        return context.getEntity("SecurityUser").findById(entry.createdBy);
    },
    updatedBy: (entry, args, context) => {
        return context.getEntity("SecurityUser").findById(entry.updatedBy);
    }
});

export default async config => {
    // Structure plugins for faster access
    const fieldTypePlugins = getPlugins("cms-headless-field-type").reduce((acc, pl) => {
        acc[pl.fieldType] = pl;
        return acc;
    }, {});

    // Load model data
    const db = config.database.mongodb;
    const models = await db
        .collection("CmsContentModel")
        .find({ deleted: { $ne: true } })
        .toArray();

    const modelPlugins = {};

    function renderFields(model, type) {
        return model.fields
            .map(f => {
                return fieldTypePlugins[f.type][type].createTypeField({ model, field: f });
            })
            .join("\n");
    }

    function renderFieldsFromPlugins(model, type) {
        const plugins = modelPlugins[model.modelId];

        return plugins.map(pl => pl[type].createTypeField({ model })).join("\n");
    }

    function renderInputFields(model) {
        return model.fields
            .map(f => {
                return fieldTypePlugins[f.type].manage.createInputField({ model, field: f });
            })
            .join("\n");
    }

    function renderListFilterFields(model, type) {
        return model.fields
            .map(field => {
                const { createListFilters } = fieldTypePlugins[field.type][type];
                if (typeof createListFilters === "function") {
                    return createListFilters({ field });
                }
            })
            .filter(Boolean)
            .join("\n");
    }

    function renderTypes(model, type) {
        return Object.values(fieldTypePlugins)
            .map(pl => {
                // Render gql types generated by field type plugins
                if (typeof pl[type].createTypes === "function") {
                    return pl[type].createTypes({ model, models });
                }
                return "";
            })
            .join("\n");
    }

    function renderTypesFromPlugins(model, type) {
        return modelPlugins[model.modelId]
            .map(pl => {
                // Render gql types generated by field type plugins
                if (typeof pl[type].createTypes === "function") {
                    return pl[type].createTypes({ model, models });
                }
                return "";
            })
            .join("\n");
    }

    function renderSortEnum(model) {
        const sorters = [];
        model.fields
            .filter(f => fieldTypePlugins[f.type].isSortable)
            .forEach(f => {
                sorters.push(`${f.fieldId}_ASC`);
                sorters.push(`${f.fieldId}_DESC`);
            });

        return sorters.join("\n");
    }

    const plugins = [];

    models.forEach(model => {
        const typeName = createTypeName(model.modelId);
        const mTypeName = createManageTypeName(typeName);
        const rTypeName = createReadTypeName(typeName);

        // Get model plugins
        modelPlugins[model.modelId] = getPlugins("cms-headless-model-field").filter(
            pl => pl.modelId === model.modelId
        );

        // Create a schema plugin for each model (Management Schema)
        plugins.push({
            name: "graphql-schema-" + model.modelId + "-manage",
            type: "graphql-schema",
            schema: {
                stitching: {
                    linkTypeDefs: /* GraphQL */ `
                    ${renderTypes(model, "manage")}
                        
                    "${model.description}"
                    type ${mTypeName} {
                        id: ID
                        createdBy: User
                        updatedBy: User
                        createdOn: DateTime
                        updatedOn: DateTime
                        savedOn: DateTime
                        ${renderFields(model, "manage")}
                    }
                    
                    input ${mTypeName}Input {
                        ${renderInputFields(model, "manage")}
                    }
                    
                    input ${mTypeName}FilterInput {
                        id: ID
                        id_not: ID
                        id_in: [ID]
                        id_not_in: [ID]
                        ${renderListFilterFields(model, "manage")}
                    }
                    
                    type ${mTypeName}Response {
                        data: ${mTypeName}
                        error: Error
                    }
                    
                    type ${mTypeName}ListResponse {
                        data: [${mTypeName}]
                        meta: ListMeta
                        error: Error
                    }
                    
                    extend type HeadlessManageQuery {
                        get${typeName}(id: ID, locale: String): ${mTypeName}Response
                        
                        list${pluralize(typeName)}(
                            locale: String
                            page: Int
                            perPage: Int
                            sort: JSON
                            where: ${mTypeName}FilterInput
                        ): ${mTypeName}ListResponse
                    }
                    
                    extend type HeadlessManageMutation{
                        create${typeName}(data: ${mTypeName}Input!): ${mTypeName}Response
                        update${typeName}(id: ID!, data: ${mTypeName}Input!): ${mTypeName}Response
                        delete${typeName}(id: ID!): DeleteResponse
                    }
                `,
                    resolvers: {
                        CmsQuery: {
                            headlessManage: {
                                fragment: "... on CmsQuery { cms }",
                                resolve: (parent, args, context) => {
                                    context.cms.headlessManage = true;
                                    return {};
                                }
                            }
                        },
                        CmsMutation: {
                            headlessManage: {
                                fragment: "... on CmsMutation { cms }",
                                resolve: resolve.dummyResolver
                            }
                        },
                        HeadlessManageQuery: {
                            [`get${typeName}`]: resolveGet({ models, model }),
                            [`list${pluralize(typeName)}`]: resolveList({ models, model })
                        },
                        HeadlessManageMutation: {
                            [`create${typeName}`]: resolveCreate({ models, model }),
                            [`update${typeName}`]: resolveUpdate({ models, model }),
                            [`delete${typeName}`]: resolve.dummyResolver
                        },
                        [mTypeName]: model.fields.reduce((resolvers, field) => {
                            const { manage } = fieldTypePlugins[field.type];
                            let resolver = (entry, args, ctx, info) => entry[info.fieldName];
                            if (typeof manage.createResolver === "function") {
                                resolver = manage.createResolver({ models, model, field });
                            }

                            resolvers[field.fieldId] = (entry, args, ctx, info) => {
                                return resolver(entry, args, ctx, info);
                            };

                            return resolvers;
                        }, commonFieldResolvers())
                    }
                }
            }
        });

        // Create a schema plugin for each model (Read-Only Schema)
        plugins.push({
            name: "graphql-schema-" + model.modelId + "-read",
            type: "graphql-schema",
            schema: {
                stitching: {
                    linkTypeDefs: /* GraphQL */ `
                    ${renderTypes(model, "read")}
                    ${renderTypesFromPlugins(model, "read")}
                        
                    "${model.description}"
                    type ${rTypeName} {
                        id: ID
                        createdBy: User
                        updatedBy: User
                        createdOn: DateTime
                        updatedOn: DateTime
                        savedOn: DateTime
                        ${renderFields(model, "read")}
                        ${renderFieldsFromPlugins(model, "read")}
                    }
                    
                    input ${rTypeName}FilterInput {
                        id: ID
                        id_not: ID
                        id_in: [ID]
                        id_not_in: [ID]
                        ${renderListFilterFields(model, "read")}
                    }
                    
                    enum ${rTypeName}Sorter {
                        createdOn_ASC
                        createdOn_DESC
                        updatedOn_ASC
                        updatedOn_DESC
                        ${renderSortEnum(model, "read")}
                    }
                    
                    type ${rTypeName}Response {
                        data: ${rTypeName}
                        error: Error
                    }
                    
                    type ${rTypeName}ListResponse {
                        data: [${rTypeName}]
                        meta: ListMeta
                        error: Error
                    }
                    
                    extend type HeadlessReadQuery {
                        get${typeName}(locale: String, where: ${rTypeName}FilterInput, sort: [${rTypeName}Sorter]): ${rTypeName}Response
                        
                        list${pluralize(typeName)}(
                            locale: String
                            page: Int
                            perPage: Int
                            where: ${rTypeName}FilterInput
                            sort: [${rTypeName}Sorter]
                        ): ${rTypeName}ListResponse
                    }
                `,
                    resolvers: {
                        CmsQuery: {
                            headlessRead: {
                                fragment: "... on CmsQuery { cms }",
                                resolve: (parent, args, context) => {
                                    /**
                                     * Create emitter for resolved values.
                                     * It is used in model field plugins to access values from sibling resolvers.
                                     */
                                    context.resolvedValues = new TypeValueEmitter();
                                    return {};
                                }
                            }
                        },
                        HeadlessReadQuery: {
                            [`get${typeName}`]: resolveGet({ model }),
                            [`list${pluralize(typeName)}`]: resolveList({ model })
                        },
                        [rTypeName]: model.fields.reduce((resolvers, field) => {
                            const { read } = fieldTypePlugins[field.type];
                            const resolver = read.createResolver({ models, model, field });

                            resolvers[field.fieldId] = (entry, args, ctx, info) => {
                                const value = resolver(entry, args, ctx, info);

                                const cacheKey = `${model.modelId}:${entry._id}:${field.fieldId}`;
                                ctx.resolvedValues.set(cacheKey, value);
                                return value;
                            };

                            modelPlugins[model.modelId].forEach(pl => {
                                resolvers[pl.fieldId] = pl.read.createResolver();
                            });

                            return resolvers;
                        }, commonFieldResolvers())
                    }
                }
            }
        });
    });

    registerPlugins(plugins);
};
