'use strict';

/**
 * @ngdoc function
 * @name openshiftConsole.controller:EditYAMLController
 * @description
 * # EditYAMLController
 * Controller of the openshiftConsole
 */
angular.module('openshiftConsole')
  .controller('EditYAMLController', function ($scope,
                                              $filter,
                                              $location,
                                              $routeParams,
                                              $window,
                                              APIService,
                                              AuthorizationService,
                                              BreadcrumbsService,
                                              DataService,
                                              Navigate,
                                              NotificationsService,
                                              ProjectsService) {
    if (!$routeParams.kind || !$routeParams.name) {
      Navigate.toErrorPage("Kind or name parameter missing.");
      return;
    }

    var humanizeKind = $filter('humanizeKind');
    $scope.alerts = {};
    $scope.name = $routeParams.name;
    $scope.resourceURL = Navigate.resourceURL($scope.name, $routeParams.kind, $routeParams.project);
    $scope.breadcrumbs = [{
      title: $routeParams.project,
      link: "project/" + $routeParams.project
    }, {
      title: $routeParams.name,
      // If returnURL is unspecified, the breadcrumbs directive defaults to back.
      link: $routeParams.returnURL
    }, {
      title: "Edit YAML"
    }];

    var navigateBack = function() {
      $scope.modified = false;
      if ($routeParams.returnURL) {
        $location.url($routeParams.returnURL);
        return;
      }

      // Default to going back in history if no returnURL.
      $window.history.back();
    };

    var onChange = _.throttle(function() {
      $scope.$eval(function() {
        $scope.modified = true;
      });
    }, 1000);

    $scope.aceLoaded = function(editor) {
      var session = editor.getSession();
      session.setOption('tabSize', 2);
      session.setOption('useSoftTabs', true);

      // Wait for the editor to initialize before adding the on change handler
      // so it's not immediately marked as modified.
      setTimeout(function() {
        session.on('change', onChange);
      });
    };

    var watches = [];
    ProjectsService
      .get($routeParams.project)
      .then(_.spread(function(project, context) {
        var resourceGroupVersion = {
          resource: APIService.kindToResource($routeParams.kind),
          group: $routeParams.group
        };

        if (!AuthorizationService.canI(resourceGroupVersion, 'update', $routeParams.project)) {
          Navigate.toErrorPage('You do not have authority to update ' +
                               humanizeKind($routeParams.kind) + ' ' + $routeParams.name + '.', 'access_denied');
          return;
        }

        DataService.get(resourceGroupVersion, $scope.name, context, { errorNotification: false }).then(
          function(result) {
            // Modify a copy of the resource.
            var resource = angular.copy(result);
            $scope.resource = resource;

            // TODO: Update the BreadcrumbsService to handle types without browse pages.
            // $scope.breadcrumbs = BreadcrumbsService.getBreadcrumbs({
            //   object: resource,
            //   subpage: 'Edit YAML',
            //   includeProject: true
            // });

            var getVersion = function(resource) {
              return _.get(resource, 'metadata.resourceVersion');
            };

            _.set($scope, 'editor.model', jsyaml.safeDump(resource, {'sortKeys': true}));

            $scope.save = function() {
              $scope.modified = false;
              var updatedResource;
              try {
                updatedResource = jsyaml.safeLoad($scope.editor.model);
              } catch (e) {
                $scope.error = e;
                return;
              }

              if (updatedResource.kind !== resource.kind) {
                $scope.error = {
                  message: 'Cannot change resource kind (original: ' + resource.kind + ', modified: ' + (updatedResource.kind || '<unspecified>') + ').'
                };
                return;
              }

              var groupVersion = APIService.objectToResourceGroupVersion(resource);
              var updatedGroupVersion = APIService.objectToResourceGroupVersion(updatedResource);
              if (!updatedGroupVersion) {
                $scope.error = { message: APIService.invalidObjectKindOrVersion(updatedResource) };
                return;
              }
              if (updatedGroupVersion.group !== groupVersion.group) {
                $scope.error = { message: 'Cannot change resource group (original: ' + (groupVersion.group || '<none>') + ', modified: ' + (updatedGroupVersion.group || '<none>') + ').' };
                return;
              }
              if (!APIService.apiInfo(updatedGroupVersion)) {
                $scope.error = { message: APIService.unsupportedObjectKindOrVersion(updatedResource) };
                return;
              }

              $scope.updatingNow = true;
              DataService.update(updatedGroupVersion, $scope.resource.metadata.name, updatedResource, {
                namespace: $scope.resource.metadata.namespace
              }).then(
                // success
                function(response) {
                  var editedResourceVersion = _.get(updatedResource, 'metadata.resourceVersion');
                  var newResourceVersion = _.get(response, 'metadata.resourceVersion');
                  if (newResourceVersion === editedResourceVersion) {
                    $scope.alerts['no-changes-applied'] = {
                      type: "warning",
                      message: "No changes were applied to " + humanizeKind($routeParams.kind) + " " + $routeParams.name + ".",
                      details: "Make sure any new fields you may have added are supported API fields."
                    };
                    $scope.updatingNow = false;
                    return;
                  }
                  NotificationsService.addNotification({
                      type: "success",
                      message: humanizeKind($routeParams.kind, true) + " " + $routeParams.name + " was successfully updated."
                  });
                  navigateBack();
                },
                // failure
                function(result) {
                  $scope.updatingNow = false;
                  $scope.error = {
                    message: $filter('getErrorDetails')(result)
                  };
                });
            };

            $scope.cancel = function() {
              navigateBack();
            };

            // Watch for changes to warn the user. If the watch failes, ignore the error since it's only used for this warning.
            // Some resources don't support watch.
            watches.push(DataService.watchObject(resourceGroupVersion, $scope.name, context, function(newValue, action) {
              $scope.resourceChanged = getVersion(newValue) !== getVersion(resource);
              $scope.resourceDeleted = action === "DELETED";
            }, {
              errorNotification: false
            }));
          },
          // GET failure
          function(e) {
            Navigate.toErrorPage("Could not load " + humanizeKind($routeParams.kind) + " '" + $routeParams.name + "'. " + $filter('getErrorDetails')(e));
          });

          $scope.$on('$destroy', function(){
            DataService.unwatchAll(watches);
          });
      }));
  });
