import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elasticloadbalancingv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';

export interface EcsServiceConnect1StackProps extends cdk.StackProps {
  /**
   * The naming prefix for all resources.
   * @default 'app'
   */
  readonly namingPrefix?: string;
  /**
   * VPC CIDR block for IPv4.
   * @default '10.0.0.0/16'
   */
  readonly vpciPv4CidrBlock?: string;
  /**
   * Host bit mask length of each subnet, e.g. default of 8 will be a /24 subnet size.
   * @default 8
   */
  readonly vpcSubnetIPv4Size?: string;
  /**
   * Number of equally sized IPv4 subnets that will be created within the VPC CIDR block.
   * @default 256
   */
  readonly vpcNumberOfIPv4Subnets?: string;
  /**
   * The number of tasks to be instantiated for the UI service.
   * @default 1
   */
  readonly countOfUiTasks?: string;
  /**
   * The number of tasks to be instantiated for the Application service.
   * @default 1
   */
  readonly countOfAppserverTasks?: string;
  /**
   * Please provide the LaunchType
   * @default 'FARGATE'
   */
  readonly launchType?: string;
}

/**
 * AWS CloudFormation for deploying a sample application in ECS Fargate and enabling service to service communication using ECS Service connect.
 */
export class EcsServiceConnect1Stack extends cdk.Stack {
  /**
   * The DNS name for the ALB
   */
  public readonly loadBalancerUrl;

  public constructor(scope: cdk.App, id: string, props: EcsServiceConnect1StackProps = {}) {
    super(scope, id, props);

    // Applying default props
    props = {
      ...props,
      namingPrefix: props.namingPrefix ?? 'app',
      vpciPv4CidrBlock: props.vpciPv4CidrBlock ?? '10.0.0.0/16',
      vpcSubnetIPv4Size: props.vpcSubnetIPv4Size ?? '8',
      vpcNumberOfIPv4Subnets: props.vpcNumberOfIPv4Subnets ?? '256',
      countOfUiTasks: props.countOfUiTasks ?? '1',
      countOfAppserverTasks: props.countOfAppserverTasks ?? '1',
      launchType: props.launchType ?? 'FARGATE',
    };

    // Resources
    const cloudMapNamespace = new servicediscovery.CfnHttpNamespace(this, 'CloudMapNamespace', {
      description: 'Namespace for the sample application.',
      name: `${props.namingPrefix!}.local`,
    });

    const ecsTaskExecutionRole = new iam.CfnRole(this, 'ECSTaskExecutionRole', {
      assumeRolePolicyDocument: {
        Statement: [
          {
            Effect: 'Allow',
            Principal: {
              Service: [
                'ecs-tasks.amazonaws.com',
              ],
            },
            Action: [
              'sts:AssumeRole',
            ],
          },
        ],
      },
      path: '/',
      policies: [
        {
          policyName: 'YelbTaskExecutionRolePolicy',
          policyDocument: {
            Statement: [
              {
                Effect: 'Allow',
                Action: [
                  'ecr:GetAuthorizationToken',
                  'ecr:BatchCheckLayerAvailability',
                  'ecr:GetDownloadUrlForLayer',
                  'ecr:BatchGetImage',
                  'logs:CreateLogStream',
                  'logs:CreateLogGroup',
                  'logs:PutLogEvents',
                  'elasticloadbalancing:DeregisterInstancesFromLoadBalancer',
                  'elasticloadbalancing:Describe*',
                  'elasticloadbalancing:RegisterInstancesWithLoadBalancer',
                  'elasticloadbalancing:DeregisterTargets',
                  'elasticloadbalancing:DescribeTargetGroups',
                  'elasticloadbalancing:DescribeTargetHealth',
                  'elasticloadbalancing:RegisterTargets',
                ],
                Resource: '*',
              },
            ],
          },
        },
      ],
    });

    const igw = new ec2.CfnInternetGateway(this, 'IGW', {
      tags: [
        {
          key: 'Name',
          value: [
            props.namingPrefix!,
            'igw',
          ].join('-'),
        },
      ],
    });

    const vpc = new ec2.CfnVPC(this, 'VPC', {
      cidrBlock: props.vpciPv4CidrBlock!,
      enableDnsSupport: true,
      enableDnsHostnames: true,
      instanceTenancy: 'default',
      tags: [
        {
          key: 'Name',
          value: [
            props.namingPrefix!,
            'vpc',
          ].join('-'),
        },
      ],
    });

    const albSecurityGroup = new ec2.CfnSecurityGroup(this, 'ALBSecurityGroup', {
      groupDescription: 'application load balancer security group',
      securityGroupIngress: [
        {
          cidrIp: '0.0.0.0/0',
          ipProtocol: 'tcp',
          toPort: 80,
          fromPort: 80,
        },
      ],
      vpcId: vpc.ref,
    });

    const appCluster = new ecs.CfnCluster(this, 'AppCluster', {
      clusterName: `${props.namingPrefix!}-ui-cluster`,
      serviceConnectDefaults: {
        namespace: cloudMapNamespace.attrArn,
      },
      capacityProviders: [
        'FARGATE_SPOT',
      ],
      defaultCapacityProviderStrategy: [
        {
          capacityProvider: 'FARGATE_SPOT',
          weight: 1,
        },
      ],
    });

    const appServerSecurityGroup = new ec2.CfnSecurityGroup(this, 'AppServerSecurityGroup', {
      groupDescription: 'appserver security group',
      securityGroupIngress: [
        {
          cidrIp: '0.0.0.0/0',
          ipProtocol: 'tcp',
          toPort: 4567,
          fromPort: 4567,
        },
      ],
      securityGroupEgress: [
        {
          fromPort: 443,
          ipProtocol: 'tcp',
          toPort: 443,
          cidrIp: '0.0.0.0/0',
        },
      ],
      vpcId: vpc.ref,
    });

    const appServerTaskDefinition = new ecs.CfnTaskDefinition(this, 'AppServerTaskDefinition', {
      networkMode: 'awsvpc',
      requiresCompatibilities: [
        'FARGATE',
      ],
      cpu: '256',
      memory: '512',
      executionRoleArn: ecsTaskExecutionRole.ref,
      family: 'appserver-taskdefinition',
      containerDefinitions: [
        {
          name: 'app-server',
          essential: true,
          image: 'mreferre/yelb-appserver:0.7',
          portMappings: [
            {
              containerPort: 4567,
              appProtocol: 'http',
              name: 'app-server',
            },
          ],
          logConfiguration: {
            logDriver: 'awslogs',
            options: {
              'awslogs-group': 'sample-ecs-app',
              'awslogs-create-group': 'true',
              'awslogs-region': this.region,
              'awslogs-stream-prefix': 'app-server',
            },
          },
        },
      ],
    });

    const appUItaskDefinition = new ecs.CfnTaskDefinition(this, 'AppUItaskDefinition', {
      networkMode: 'awsvpc',
      requiresCompatibilities: [
        'FARGATE',
      ],
      cpu: '256',
      memory: '512',
      executionRoleArn: ecsTaskExecutionRole.ref,
      family: 'app-ui-taskdefinition',
      containerDefinitions: [
        {
          name: 'app-ui',
          essential: true,
          image: 'mreferre/yelb-ui:0.10',
          portMappings: [
            {
              containerPort: 80,
              appProtocol: 'http',
              name: 'app-ui',
            },
          ],
          logConfiguration: {
            logDriver: 'awslogs',
            options: {
              'awslogs-group': 'sample-ecs-app',
              'awslogs-create-group': 'true',
              'awslogs-region': this.region,
              'awslogs-stream-prefix': 'app-ui',
            },
          },
        },
      ],
    });

    const dbTaskDefinition = new ecs.CfnTaskDefinition(this, 'DBTaskDefinition', {
      networkMode: 'awsvpc',
      requiresCompatibilities: [
        'FARGATE',
      ],
      cpu: '256',
      memory: '512',
      executionRoleArn: ecsTaskExecutionRole.ref,
      family: 'db-taskdefinition',
      containerDefinitions: [
        {
          name: 'postgres-db',
          essential: true,
          image: 'mreferre/yelb-db:0.6',
          portMappings: [
            {
              containerPort: 5432,
              name: 'postgres-db',
              protocol: 'tcp',
            },
          ],
          logConfiguration: {
            logDriver: 'awslogs',
            options: {
              'awslogs-group': 'sample-ecs-app',
              'awslogs-create-group': 'true',
              'awslogs-region': this.region,
              'awslogs-stream-prefix': 'postgres-db',
            },
          },
        },
      ],
    });

    const igwAttach = new ec2.CfnVPCGatewayAttachment(this, 'IGWAttach', {
      vpcId: vpc.ref,
      internetGatewayId: igw.ref,
    });

    const publicSubnet1 = new ec2.CfnSubnet(this, 'PublicSubnet1', {
      availabilityZone: cdk.Fn.select(0, cdk.Fn.getAzs(this.region)),
      cidrBlock: cdk.Fn.select(1, cdk.Fn.cidr(vpc.attrCidrBlock, +props.vpcNumberOfIPv4Subnets!, String(props.vpcSubnetIPv4Size!))),
      tags: [
        {
          key: 'Name',
          value: `${props.namingPrefix!}-publicsubnet-a`,
        },
      ],
      vpcId: vpc.ref,
    });

    const publicSubnet2 = new ec2.CfnSubnet(this, 'PublicSubnet2', {
      availabilityZone: cdk.Fn.select(1, cdk.Fn.getAzs(this.region)),
      cidrBlock: cdk.Fn.select(2, cdk.Fn.cidr(vpc.attrCidrBlock, +props.vpcNumberOfIPv4Subnets!, String(props.vpcSubnetIPv4Size!))),
      tags: [
        {
          key: 'Name',
          value: `${props.namingPrefix!}-publicsubnet-b`,
        },
      ],
      vpcId: vpc.ref,
    });

    const publicSubnetRouteTable = new ec2.CfnRouteTable(this, 'PublicSubnetRouteTable', {
      vpcId: vpc.ref,
      tags: [
        {
          key: 'Name',
          value: [
            props.namingPrefix!,
            'public',
            'rtb',
          ].join('-'),
        },
      ],
    });

    const redisTaskDefinition = new ecs.CfnTaskDefinition(this, 'RedisTaskDefinition', {
      networkMode: 'awsvpc',
      requiresCompatibilities: [
        'FARGATE',
      ],
      cpu: '256',
      memory: '512',
      executionRoleArn: ecsTaskExecutionRole.ref,
      family: 'redis-taskdefinition',
      containerDefinitions: [
        {
          name: 'redis-server',
          essential: true,
          image: 'redis:4.0.2',
          portMappings: [
            {
              containerPort: 6379,
              name: 'redis-server',
              protocol: 'tcp',
            },
          ],
          logConfiguration: {
            logDriver: 'awslogs',
            options: {
              'awslogs-group': 'sample-ecs-app',
              'awslogs-create-group': 'true',
              'awslogs-region': this.region,
              'awslogs-stream-prefix': 'redis-server',
            },
          },
        },
      ],
    });

    const storageCluster = new ecs.CfnCluster(this, 'StorageCluster', {
      clusterName: `${props.namingPrefix!}-storage-cluster`,
      serviceConnectDefaults: {
        namespace: cloudMapNamespace.attrArn,
      },
      capacityProviders: [
        'FARGATE_SPOT',
      ],
      defaultCapacityProviderStrategy: [
        {
          capacityProvider: 'FARGATE_SPOT',
          weight: 1,
        },
      ],
    });

    const uiTargetGroup = new elasticloadbalancingv2.CfnTargetGroup(this, 'UITargetGroup', {
      healthCheckIntervalSeconds: 6,
      healthCheckPath: '/',
      healthCheckProtocol: 'HTTP',
      healthCheckTimeoutSeconds: 5,
      healthyThresholdCount: 2,
      targetType: 'ip',
      vpcId: vpc.ref,
      port: 80,
      protocol: 'HTTP',
    });

    const dbSecurityGroup = new ec2.CfnSecurityGroup(this, 'DBSecurityGroup', {
      groupDescription: 'db security group',
      securityGroupIngress: [
        {
          sourceSecurityGroupId: appServerSecurityGroup.ref,
          ipProtocol: 'tcp',
          toPort: 5432,
          fromPort: 5432,
        },
      ],
      securityGroupEgress: [
        {
          fromPort: 443,
          ipProtocol: 'tcp',
          toPort: 443,
          cidrIp: '0.0.0.0/0',
        },
      ],
      vpcId: vpc.ref,
    });

    const loadBalancer = new elasticloadbalancingv2.CfnLoadBalancer(this, 'LoadBalancer', {
      scheme: 'internet-facing',
      subnets: [
        publicSubnet1.ref,
        publicSubnet2.ref,
      ],
      securityGroups: [
        albSecurityGroup.ref,
      ],
    });

    const publicSubnetRoute = new ec2.CfnRoute(this, 'PublicSubnetRoute', {
      destinationCidrBlock: '0.0.0.0/0',
      gatewayId: igw.ref,
      routeTableId: publicSubnetRouteTable.ref,
    });

    const publicSubnetRouteTableAssociation1 = new ec2.CfnSubnetRouteTableAssociation(this, 'PublicSubnetRouteTableAssociation1', {
      routeTableId: publicSubnetRouteTable.ref,
      subnetId: publicSubnet1.ref,
    });

    const publicSubnetRouteTableAssociation2 = new ec2.CfnSubnetRouteTableAssociation(this, 'PublicSubnetRouteTableAssociation2', {
      routeTableId: publicSubnetRouteTable.ref,
      subnetId: publicSubnet2.ref,
    });

    const redisServerSecurityGroup = new ec2.CfnSecurityGroup(this, 'RedisServerSecurityGroup', {
      groupDescription: 'redis-server security group',
      securityGroupIngress: [
        {
          sourceSecurityGroupId: appServerSecurityGroup.ref,
          ipProtocol: 'tcp',
          toPort: 6379,
          fromPort: 6379,
        },
      ],
      securityGroupEgress: [
        {
          fromPort: 443,
          ipProtocol: 'tcp',
          toPort: 443,
          cidrIp: '0.0.0.0/0',
        },
      ],
      vpcId: vpc.ref,
    });

    const uiSecurityGroup = new ec2.CfnSecurityGroup(this, 'UISecurityGroup', {
      groupDescription: 'ui security group',
      securityGroupIngress: [
        {
          sourceSecurityGroupId: albSecurityGroup.ref,
          ipProtocol: 'tcp',
          toPort: 80,
          fromPort: 80,
        },
      ],
      securityGroupEgress: [
        {
          fromPort: 443,
          ipProtocol: 'tcp',
          toPort: 443,
          cidrIp: '0.0.0.0/0',
        },
        {
          fromPort: 4567,
          ipProtocol: 'tcp',
          toPort: 4567,
          destinationSecurityGroupId: appServerSecurityGroup.ref,
        },
      ],
      vpcId: vpc.ref,
    });

    const albSecurityGroupEgress = new ec2.CfnSecurityGroupEgress(this, 'ALBSecurityGroupEgress', {
      destinationSecurityGroupId: uiSecurityGroup.ref,
      ipProtocol: 'tcp',
      toPort: 80,
      fromPort: 80,
      groupId: albSecurityGroup.ref,
    });

    const appServerSecurityGroupDbEgress = new ec2.CfnSecurityGroupEgress(this, 'AppServerSecurityGroupDBEgress', {
      destinationSecurityGroupId: dbSecurityGroup.ref,
      ipProtocol: 'tcp',
      toPort: 5432,
      fromPort: 5432,
      groupId: appServerSecurityGroup.ref,
    });

    const appServerSecurityGroupRedisEgress = new ec2.CfnSecurityGroupEgress(this, 'AppServerSecurityGroupRedisEgress', {
      destinationSecurityGroupId: redisServerSecurityGroup.ref,
      ipProtocol: 'tcp',
      toPort: 6379,
      fromPort: 6379,
      groupId: appServerSecurityGroup.ref,
    });

    const dbService = new ecs.CfnService(this, 'DBService', {
      launchType: props.launchType!,
      cluster: storageCluster.ref,
      desiredCount: 1,
      taskDefinition: dbTaskDefinition.ref,
      networkConfiguration: {
        awsvpcConfiguration: {
          assignPublicIp: 'ENABLED',
          subnets: [
            publicSubnet1.ref,
            publicSubnet2.ref,
          ],
          securityGroups: [
            dbSecurityGroup.ref,
          ],
        },
      },
      serviceConnectConfiguration: {
        enabled: true,
        services: [
          {
            portName: 'postgres-db',
            discoveryName: 'yelb-db',
            clientAliases: [
              {
                dnsName: 'yelb-db',
                port: 5432,
              },
            ],
          },
        ],
        logConfiguration: {
          logDriver: 'awslogs',
          options: {
            'awslogs-create-group': 'true',
            'awslogs-group': 'sample-ecs-app',
            'awslogs-region': this.region,
            'awslogs-stream-prefix': 'postgres-db-serviceconnect',
          },
        },
      },
    });

    const loadBalancerListener = new elasticloadbalancingv2.CfnListener(this, 'LoadBalancerListener', {
      loadBalancerArn: loadBalancer.ref,
      port: 80,
      protocol: 'HTTP',
      defaultActions: [
        {
          type: 'forward',
          targetGroupArn: uiTargetGroup.ref,
        },
      ],
    });

    const redisService = new ecs.CfnService(this, 'RedisService', {
      launchType: props.launchType!,
      cluster: storageCluster.ref,
      desiredCount: 1,
      taskDefinition: redisTaskDefinition.ref,
      networkConfiguration: {
        awsvpcConfiguration: {
          assignPublicIp: 'ENABLED',
          subnets: [
            publicSubnet1.ref,
            publicSubnet2.ref,
          ],
          securityGroups: [
            redisServerSecurityGroup.ref,
          ],
        },
      },
      serviceConnectConfiguration: {
        enabled: true,
        services: [
          {
            portName: 'redis-server',
            discoveryName: 'redis-server',
            clientAliases: [
              {
                dnsName: 'redis-server',
                port: 6379,
              },
            ],
          },
        ],
        logConfiguration: {
          logDriver: 'awslogs',
          options: {
            'awslogs-create-group': 'true',
            'awslogs-group': 'sample-ecs-app',
            'awslogs-region': this.region,
            'awslogs-stream-prefix': 'redis-serviceconnect',
          },
        },
      },
    });

    const appService = new ecs.CfnService(this, 'AppService', {
      launchType: props.launchType!,
      cluster: appCluster.ref,
      desiredCount: 1,
      taskDefinition: appServerTaskDefinition.ref,
      networkConfiguration: {
        awsvpcConfiguration: {
          assignPublicIp: 'ENABLED',
          subnets: [
            publicSubnet1.ref,
            publicSubnet2.ref,
          ],
          securityGroups: [
            appServerSecurityGroup.ref,
          ],
        },
      },
      serviceConnectConfiguration: {
        enabled: true,
        services: [
          {
            portName: 'app-server',
            discoveryName: 'yelb-appserver',
            clientAliases: [
              {
                dnsName: 'yelb-appserver',
                port: 4567,
              },
            ],
          },
        ],
        logConfiguration: {
          logDriver: 'awslogs',
          options: {
            'awslogs-create-group': 'true',
            'awslogs-group': 'sample-ecs-app',
            'awslogs-region': this.region,
            'awslogs-stream-prefix': 'app-serviceconnect',
          },
        },
      },
    });
    appService.addDependency(redisService);
    appService.addDependency(dbService);

    const uiService = new ecs.CfnService(this, 'UIService', {
      launchType: props.launchType!,
      cluster: appCluster.ref,
      desiredCount: 1,
      taskDefinition: appUItaskDefinition.ref,
      networkConfiguration: {
        awsvpcConfiguration: {
          assignPublicIp: 'ENABLED',
          subnets: [
            publicSubnet1.ref,
            publicSubnet2.ref,
          ],
          securityGroups: [
            uiSecurityGroup.ref,
          ],
        },
      },
      loadBalancers: [
        {
          targetGroupArn: uiTargetGroup.ref,
          containerPort: 80,
          containerName: 'app-ui',
        },
      ],
      serviceConnectConfiguration: {
        enabled: true,
        services: [
          {
            portName: 'app-ui',
            discoveryName: 'yelb-ui',
            clientAliases: [
              {
                dnsName: 'yelb-ui',
                port: 80,
              },
            ],
          },
        ],
        logConfiguration: {
          logDriver: 'awslogs',
          options: {
            'awslogs-create-group': 'true',
            'awslogs-group': 'sample-ecs-app',
            'awslogs-region': this.region,
            'awslogs-stream-prefix': 'ui-serviceconnect',
          },
        },
      },
    });
    uiService.addDependency(loadBalancerListener);
    uiService.addDependency(appService);

    // Outputs
    this.loadBalancerUrl = loadBalancer.attrDnsName;
    new cdk.CfnOutput(this, 'CfnOutputLoadBalancerUrl', {
      key: 'LoadBalancerUrl',
      description: 'The DNS name for the ALB',
      value: this.loadBalancerUrl!.toString(),
    });
  }
}
